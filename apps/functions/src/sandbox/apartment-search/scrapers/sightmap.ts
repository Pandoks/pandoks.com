import { getCompressedText, getText, priceToCents } from './lib';

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

interface SightmapPricingOption {
  lease_term: number;
  display_price: string;
}

export function normalizeUnitNumber(raw: string | undefined): string {
  return String(raw ?? '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

export async function discoverSightmapContext(
  signal: AbortSignal,
  propertyUrl: string
): Promise<SightmapContext> {
  const pricingPageUrl = `${propertyUrl.replace(/\/$/, '')}/floor-plans-and-pricing`;
  const pricingHtml = await getText(signal, pricingPageUrl, {
    accept: 'text/html,application/xhtml+xml'
  });

  let embedToken: string | null = null;
  for (const match of pricingHtml.matchAll(/sightmap\.com\/embed\/([a-z0-9]+)/gi)) {
    const token = match[1].toLowerCase();
    if (token === 'api' || token.length < 6) continue;
    embedToken = token;
    break;
  }
  if (!embedToken) {
    throw new Error(`sightmap: could not extract embed token from ${pricingPageUrl}`);
  }

  const embedHtml = await getCompressedText(signal, `${SIGHTMAP_ORIGIN}/embed/${embedToken}`);
  const boot = embedHtml
    .replace(/\\\//g, '/')
    .match(/\/app\/api\/v1\/([a-z0-9]+)\/sightmaps\/(\d+)/i);
  if (!boot) {
    throw new Error(`sightmap: could not extract bootstrap URL from embed ${embedToken}`);
  }
  const [, embedKey, sightmapId] = boot;

  const referer = { referer: `${SIGHTMAP_ORIGIN}/embed/${embedToken}` };
  const bootstrapUrl = `${SIGHTMAP_ORIGIN}/app/api/v1/${embedKey}/sightmaps/${sightmapId}`;
  const bootstrapBody = await getCompressedText(signal, bootstrapUrl, referer);
  const units =
    (JSON.parse(bootstrapBody) as { data?: { units?: SightmapBulkUnit[] } }).data?.units ?? [];

  if (!units.length) {
    return { embedToken, embedKey, sightmapId, leasingToken: '', unitIdByNumber: new Map() };
  }

  const leasingToken = units[0].leasing_price_url?.match(/\/leasing\/([a-z0-9]+)\/unit/i)?.[1];
  if (!leasingToken) {
    throw new Error(`sightmap: could not extract leasing token from units[0].leasing_price_url`);
  }

  const unitIdByNumber = new Map<string, string>();
  for (const u of units) {
    const key = normalizeUnitNumber(u.unit_number);
    if (key) unitIdByNumber.set(key, u.id);
  }

  return { embedToken, embedKey, sightmapId, leasingToken, unitIdByNumber };
}

export async function getCheapestInWindow(
  signal: AbortSignal,
  ctx: SightmapContext,
  unitId: string,
  windowStart: string,
  windowEnd: string
): Promise<{ price: string; date: string } | null> {
  const referer = { referer: `${SIGHTMAP_ORIGIN}/embed/${ctx.embedToken}` };
  const leasingBase = `${SIGHTMAP_ORIGIN}/app/api/v1/leasing/${ctx.leasingToken}/unit/${unitId}`;

  const startDatesBody = await getCompressedText(
    signal,
    `${leasingBase}/start-dates?show_days_out_from_available_date=1`,
    referer
  );
  const startDates = (JSON.parse(startDatesBody) as { data?: string[] }).data ?? [];
  const inWindow = startDates.filter((d) => d >= windowStart && d <= windowEnd);
  if (!inWindow.length) return null;

  const quotes = await Promise.all(
    inWindow.map(async (date) => {
      const body = await getCompressedText(
        signal,
        `${leasingBase}?sightmap_id=${ctx.sightmapId}&currency_code=USD&date=${date}`,
        referer
      );
      const options =
        (JSON.parse(body) as { data?: { options?: SightmapPricingOption[] } }).data?.options ?? [];
      const twelve = options.find((o) => o.lease_term === 12);
      return twelve?.display_price ? { price: twelve.display_price, date } : null;
    })
  );

  let best: { price: string; date: string } | null = null;
  let bestCents = Infinity;
  for (const q of quotes) {
    if (!q) continue;
    const cents = priceToCents(q.price) ?? Infinity;
    if (cents < bestCents) {
      best = q;
      bestCents = cents;
    }
  }
  return best;
}
