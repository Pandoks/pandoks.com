import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Resource } from 'sst';
import { priceToCents, extractUnitNumberValue } from './scrapers/lib';
import type { AlertMatch, AlertRules, Target } from './types';
import type { TargetResult, Unit } from './scrapers/types';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});
const TABLE_NAME = Resource.ApartmentSearchKV.name;
const TTL_DAYS = 30;
const MAX_RETRIES = 3;

interface UnitRecord {
  unitKey: string;
  price: number;
  change?: 'new' | 'price_up' | 'price_down' | 'out_of_range';
  previousPrice?: number;
  sentTo?: string[];
}

async function batchGet(keys: string[]): Promise<Map<string, UnitRecord>> {
  const result = new Map<string, UnitRecord>();
  if (!keys.length) return result;

  for (let i = 0; i < keys.length; i += 100) {
    let pending: Record<string, { Keys: Record<string, unknown>[] }> | undefined = {
      [TABLE_NAME]: { Keys: keys.slice(i, i + 100).map((unitKey) => ({ unitKey })) }
    };

    for (
      let attempt = 0;
      attempt < MAX_RETRIES && pending && Object.keys(pending).length;
      attempt++
    ) {
      const response = await client.send(new BatchGetCommand({ RequestItems: pending }));

      for (const item of response.Responses?.[TABLE_NAME] ?? []) {
        result.set(item.unitKey as string, item as unknown as UnitRecord);
      }

      pending = response.UnprocessedKeys as typeof pending;
    }
  }

  return result;
}

async function batchPut(records: UnitRecord[]): Promise<void> {
  if (!records.length) return;

  const ttl = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;

  for (let i = 0; i < records.length; i += 25) {
    let pending: Record<string, { PutRequest: { Item: Record<string, unknown> } }[]> | undefined = {
      [TABLE_NAME]: records.slice(i, i + 25).map((record) => ({
        PutRequest: { Item: { ...record, ttl } }
      }))
    };

    for (
      let attempt = 0;
      attempt < MAX_RETRIES && pending && Object.keys(pending).length;
      attempt++
    ) {
      const response = await client.send(new BatchWriteCommand({ RequestItems: pending }));
      pending = response.UnprocessedItems as typeof pending;
    }
  }
}

function matchesStructure(unit: Unit, rules?: AlertRules): boolean {
  if (!rules) return true;

  if (rules.unitNumbers?.length) {
    const unitStr = (unit.number ?? '').trim();
    if (!rules.unitNumbers.some((n) => unitStr === n || unitStr.endsWith(n))) return false;
  } else {
    const unitNum = extractUnitNumberValue(unit.number);
    if (rules.unitNumberMin != null && (unitNum == null || unitNum < rules.unitNumberMin))
      return false;
    if (rules.unitNumberMax != null && (unitNum == null || unitNum > rules.unitNumberMax))
      return false;
  }

  if (rules.bedrooms?.length) {
    const bed = Number.parseFloat(unit.bedrooms ?? '');
    if (Number.isNaN(bed) || !rules.bedrooms.includes(Math.floor(bed))) return false;
  }

  if (rules.minFloor != null || rules.maxFloor != null) {
    const unitNum = extractUnitNumberValue(unit.number);
    const floor = unitNum != null && unitNum >= 100 ? Math.floor(unitNum / 100) : null;
    if (rules.minFloor != null && (floor == null || floor < rules.minFloor)) return false;
    if (rules.maxFloor != null && (floor == null || floor > rules.maxFloor)) return false;
  }

  if (rules.moveInAfter != null || rules.moveInBefore != null) {
    const d = unit.availableDate ? new Date(unit.availableDate) : null;
    if (!d || Number.isNaN(d.getTime())) return false;
    const available = d.toISOString().slice(0, 10);
    if (rules.moveInAfter != null && available < rules.moveInAfter) return false;
    if (rules.moveInBefore != null && available > rules.moveInBefore) return false;
  }

  return true;
}

function priceStatus(
  priceCents: number,
  rules?: AlertRules
): 'in_range' | 'above_max' | 'below_min' {
  if (!rules) return 'in_range';
  if (rules.minPrice != null && priceCents < Math.round(rules.minPrice * 100)) return 'below_min';
  if (rules.maxPrice != null && priceCents > Math.round(rules.maxPrice * 100)) return 'above_max';
  return 'in_range';
}

export interface ProcessedResults {
  alerts: AlertMatch[];
  toWrite: UnitRecord[];
  alertToRecord: Map<AlertMatch, UnitRecord>;
}

function formatPrice(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function processResults(
  targets: Target[],
  results: TargetResult[],
  recipients: string[]
): Promise<ProcessedResults> {
  const recipientCount = recipients.length;
  const alerts: AlertMatch[] = [];
  const alertToRecord = new Map<AlertMatch, UnitRecord>();
  const allKeys: string[] = [];
  const keyToContext = new Map<string, { target: Target; result: TargetResult; unit: Unit }>();

  for (let i = 0; i < results.length; i++) {
    const target = targets[i];
    const result = results[i];
    if (!target || !result) continue;

    for (const unit of result.units) {
      if (!matchesStructure(unit, target.rules)) continue;
      const id = target.url ?? target.name;
      const key = `${target.source}#${id}#${unit.number ?? unit.id ?? 'unknown'}`;
      allKeys.push(key);
      keyToContext.set(key, { target, result, unit });
    }
  }

  const existing = await batchGet(allKeys);
  const toWrite: UnitRecord[] = [];

  for (const key of allKeys) {
    const ctx = keyToContext.get(key)!;
    const currentPrice = priceToCents(ctx.unit.price);
    if (currentPrice == null) continue;

    const status = priceStatus(currentPrice, ctx.target.rules);
    if (status === 'below_min') continue;

    const record = existing.get(key);
    const watched = ctx.target.watchUnits?.some(
      (n) => (ctx.unit.number ?? '') === n || (ctx.unit.number ?? '').endsWith(n)
    );
    const makeAlert = (
      change: AlertMatch['change'],
      previousPrice?: number,
      alreadySent: string[] = []
    ): AlertMatch => ({
      source: ctx.result.source,
      targetName: ctx.result.name,
      unit: ctx.unit,
      change,
      previousPrice: previousPrice != null ? formatPrice(previousPrice) : undefined,
      watched,
      alreadySent
    });

    let next: UnitRecord;
    let alert: AlertMatch | null = null;

    if (status === 'above_max') {
      if (!record) continue;
      if (record.change === 'out_of_range') {
        const sentTo = record.sentTo ?? [];
        next = {
          unitKey: key,
          price: Math.max(record.price, currentPrice),
          change: 'out_of_range',
          previousPrice: record.previousPrice,
          sentTo
        };
        if (sentTo.length < recipientCount) {
          alert = makeAlert('out_of_range', record.previousPrice, [...sentTo]);
        }
      } else {
        next = {
          unitKey: key,
          price: currentPrice,
          change: 'out_of_range',
          previousPrice: record.price,
          sentTo: []
        };
        alert = makeAlert('out_of_range', record.price);
      }
    } else if (!record) {
      next = { unitKey: key, price: currentPrice, change: 'new', sentTo: [] };
      alert = makeAlert('new');
    } else if (record.change === 'out_of_range') {
      next = {
        unitKey: key,
        price: currentPrice,
        change: 'price_down',
        previousPrice: record.price,
        sentTo: []
      };
      alert = makeAlert('price_down', record.price);
    } else if (currentPrice !== record.price) {
      const change = currentPrice < record.price ? 'price_down' : 'price_up';
      next = {
        unitKey: key,
        price: currentPrice,
        change,
        previousPrice: record.price,
        sentTo: []
      };
      alert = makeAlert(change, record.price);
    } else {
      const isLegacy = record.change === undefined && record.sentTo === undefined;
      const sentTo = isLegacy ? [...recipients] : record.sentTo ?? [];
      next = {
        unitKey: key,
        price: currentPrice,
        change: record.change,
        previousPrice: record.previousPrice,
        sentTo
      };
      if (!isLegacy && sentTo.length < recipientCount) {
        alert = makeAlert(record.change ?? 'new', record.previousPrice, [...sentTo]);
      }
    }

    toWrite.push(next);
    if (alert) {
      alerts.push(alert);
      alertToRecord.set(alert, next);
    }
  }

  return { alerts, toWrite, alertToRecord };
}

export async function persistState(toWrite: UnitRecord[]): Promise<void> {
  await batchPut(toWrite);
}
