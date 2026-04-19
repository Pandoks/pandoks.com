import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Resource } from 'sst';
import { priceToCents, extractUnitNumberValue } from './scrapers/lib';
import type { AlertMatch, AlertRules, Target } from './types';
import type { TargetResult, Unit } from './scrapers/types';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = Resource.ApartmentSearchKV.name;
const TTL_DAYS = 30;
const MAX_RETRIES = 3;

interface UnitRecord {
  unitKey: string;
  price: number;
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

function matchesRules(unit: Unit, rules?: AlertRules): boolean {
  if (!rules) return true;

  const price = priceToCents(unit.price);
  if (price == null) return false;
  if (rules.minPrice != null && price < Math.round(rules.minPrice * 100)) return false;
  if (rules.maxPrice != null && price > Math.round(rules.maxPrice * 100)) return false;

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

export interface ProcessedResults {
  alerts: AlertMatch[];
  toWrite: UnitRecord[];
}

export async function processResults(
  targets: Target[],
  results: TargetResult[]
): Promise<ProcessedResults> {
  const alerts: AlertMatch[] = [];
  const allKeys: string[] = [];
  const keyToContext = new Map<string, { target: Target; result: TargetResult; unit: Unit }>();

  for (let i = 0; i < results.length; i++) {
    const target = targets[i];
    const result = results[i];
    if (!target || !result) continue;

    for (const unit of result.units) {
      if (!matchesRules(unit, target.rules)) continue;
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

    const record = existing.get(key);
    const watched = ctx.target.watchUnits?.some(
      (n) => (ctx.unit.number ?? '') === n || (ctx.unit.number ?? '').endsWith(n)
    );

    if (!record) {
      alerts.push({
        source: ctx.result.source,
        targetName: ctx.result.name,
        unit: ctx.unit,
        change: 'new',
        watched
      });
    } else if (currentPrice < record.price) {
      alerts.push({
        source: ctx.result.source,
        targetName: ctx.result.name,
        unit: ctx.unit,
        change: 'price_down',
        previousPrice: `$${(record.price / 100).toFixed(2)}`,
        watched
      });
    } else if (currentPrice > record.price) {
      alerts.push({
        source: ctx.result.source,
        targetName: ctx.result.name,
        unit: ctx.unit,
        change: 'price_up',
        previousPrice: `$${(record.price / 100).toFixed(2)}`,
        watched
      });
    }

    toWrite.push({ unitKey: key, price: currentPrice });
  }

  return { alerts, toWrite };
}

export async function persistState(toWrite: UnitRecord[]): Promise<void> {
  await batchPut(toWrite);
}
