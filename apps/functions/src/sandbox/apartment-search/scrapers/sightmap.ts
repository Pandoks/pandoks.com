import { getCompressedText, getText } from './lib';

const SIGHTMAP_ORIGIN = 'https://sightmap.com';

export interface SightmapContext {
  embedToken: string;
  embedKey: string;
  sightmapId: string;
  leasingToken: string;
  unitIdByNumber: Map<string, string>;
}

interface SightmapBulkUnit {
  id: string;
  unit_number: string;
  leasing_price_url?: string;
}

interface SightmapBulkData {
  units?: SightmapBulkUnit[];
}

interface SightmapPricingOption {
  lease_term: number;
  display_price: string;
  price?: number;
}

export function normalizeUnitNumber(raw: string | undefined): string {
  return String(raw ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function extractEmbedToken(html: string): string | null {
  for (const match of html.matchAll(/sightmap\.com\/embed\/([a-z0-9]+)/gi)) {
    const token = match[1].toLowerCase();
    if (token === 'api' || token.length < 6) continue;
    return token;
  }
  return null;
}

function extractBootstrap(embedHtml: string): { embedKey: string; sightmapId: string } | null {
  const unescaped = embedHtml.replace(/\\\//g, '/');
  const match = unescaped.match(/\/app\/api\/v1\/([a-z0-9]+)\/sightmaps\/(\d+)/i);
  if (!match) return null;
  return { embedKey: match[1], sightmapId: match[2] };
}

function extractLeasingToken(unit: SightmapBulkUnit): string | null {
  return unit.leasing_price_url?.match(/\/leasing\/([a-z0-9]+)\/unit/i)?.[1] ?? null;
}

function referer(embedToken: string): Record<string, string> {
  return { referer: `${SIGHTMAP_ORIGIN}/embed/${embedToken}` };
}

export function toIsoDate(value: string | undefined): string | null {
  if (!value) return null;
  const iso = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

export function overlapDates(
  startDates: string[],
  windowStart: string,
  windowEnd: string
): string[] {
  return startDates.filter((d) => d >= windowStart && d <= windowEnd);
}

function pick12MonthPrice(options: SightmapPricingOption[]): SightmapPricingOption | null {
  return options.find((o) => o.lease_term === 12) ?? null;
}

export async function discoverSightmapContext(
  signal: AbortSignal,
  propertyUrl: string
): Promise<SightmapContext> {
  const pricingPageUrl = `${propertyUrl.replace(/\/$/, '')}/floor-plans-and-pricing`;
  const pricingHtml = await getText(signal, pricingPageUrl, { accept: 'text/html,application/xhtml+xml' });
  const embedToken = extractEmbedToken(pricingHtml);
  if (!embedToken) {
    throw new Error(`sightmap: could not extract embed token from ${pricingPageUrl}`);
  }

  const embedHtml = await getCompressedText(signal, `${SIGHTMAP_ORIGIN}/embed/${embedToken}`);
  const boot = extractBootstrap(embedHtml);
  if (!boot) {
    throw new Error(`sightmap: could not extract bootstrap URL from embed ${embedToken}`);
  }

  const bootstrapUrl = `${SIGHTMAP_ORIGIN}/app/api/v1/${boot.embedKey}/sightmaps/${boot.sightmapId}`;
  const bootstrapBody = await getCompressedText(signal, bootstrapUrl, referer(embedToken));
  const data = (JSON.parse(bootstrapBody) as { data?: SightmapBulkData }).data;
  const units = data?.units ?? [];

  if (!units.length) {
    return {
      embedToken,
      embedKey: boot.embedKey,
      sightmapId: boot.sightmapId,
      leasingToken: '',
      unitIdByNumber: new Map()
    };
  }

  const leasingToken = extractLeasingToken(units[0]);
  if (!leasingToken) {
    throw new Error(`sightmap: could not extract leasing token from units[0].leasing_price_url`);
  }

  const unitIdByNumber = new Map<string, string>();
  for (const u of units) {
    const key = normalizeUnitNumber(u.unit_number);
    if (key) unitIdByNumber.set(key, u.id);
  }

  return {
    embedToken,
    embedKey: boot.embedKey,
    sightmapId: boot.sightmapId,
    leasingToken,
    unitIdByNumber
  };
}

export async function getUnitStartDates(
  signal: AbortSignal,
  ctx: SightmapContext,
  unitId: string
): Promise<string[]> {
  const url = `${SIGHTMAP_ORIGIN}/app/api/v1/leasing/${ctx.leasingToken}/unit/${unitId}/start-dates?show_days_out_from_available_date=1`;
  const body = await getCompressedText(signal, url, referer(ctx.embedToken));
  const parsed = JSON.parse(body) as { data?: string[] };
  return parsed.data ?? [];
}

export async function getUnitPricing(
  signal: AbortSignal,
  ctx: SightmapContext,
  unitId: string,
  date: string
): Promise<SightmapPricingOption[]> {
  const url = `${SIGHTMAP_ORIGIN}/app/api/v1/leasing/${ctx.leasingToken}/unit/${unitId}?sightmap_id=${ctx.sightmapId}&currency_code=USD&date=${date}`;
  const body = await getCompressedText(signal, url, referer(ctx.embedToken));
  const parsed = JSON.parse(body) as { data?: { options?: SightmapPricingOption[] } };
  return parsed.data?.options ?? [];
}

export async function getCheapestInWindow(
  signal: AbortSignal,
  ctx: SightmapContext,
  unitId: string,
  windowStart: string,
  windowEnd: string
): Promise<{ price: string; date: string } | null> {
  const startDates = await getUnitStartDates(signal, ctx, unitId);
  const overlap = overlapDates(startDates, windowStart, windowEnd);
  if (!overlap.length) return null;

  const earliest = overlap[0];
  const options = await getUnitPricing(signal, ctx, unitId, earliest);
  const twelveMonth = pick12MonthPrice(options);
  if (!twelveMonth?.display_price) return null;

  return { price: twelveMonth.display_price, date: earliest };
}
