import { ProxyAgent } from 'undici';
import { Resource } from 'sst';

const USER_AGENT = 'apartment-scraper/1.0';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function withTimeout(signal: AbortSignal, timeoutMs: number) {
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : signal;
}

function headers(init: Record<string, string> = {}) {
  return { 'user-agent': USER_AGENT, ...init };
}

let cachedUnblockerAgent: ProxyAgent | undefined;
function unblockerAgent() {
  if (!cachedUnblockerAgent) {
    const user = Resource.OxylabsWebUnblockerUsername.value;
    const pass = Resource.OxylabsWebUnblockerPassword.value;
    const token = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    cachedUnblockerAgent = new ProxyAgent({
      uri: 'https://unblock.oxylabs.io:60000',
      token,
      requestTls: { rejectUnauthorized: false }
    });
  }
  return cachedUnblockerAgent;
}

async function ensureOk(response: Response, rawUrl: string) {
  if (response.ok) return;
  const body = (await response.text()).slice(0, 4096).trim();
  throw new Error(`${rawUrl} returned ${response.status} ${response.statusText}: ${body}`);
}

export async function getText(
  signal: AbortSignal,
  rawUrl: string,
  init: Record<string, string> = {},
  timeoutMs = 15_000
) {
  const response = await fetch(rawUrl, {
    method: 'GET',
    headers: headers(init),
    signal: withTimeout(signal, timeoutMs)
  });
  await ensureOk(response, rawUrl);
  return response.text();
}

export async function getCompressedText(
  signal: AbortSignal,
  rawUrl: string,
  init: Record<string, string> = {},
  timeoutMs = 15_000
) {
  const response = await fetch(rawUrl, {
    method: 'GET',
    headers: {
      'user-agent': BROWSER_UA,
      'accept-encoding': 'gzip, deflate, br',
      ...init
    },
    signal: withTimeout(signal, timeoutMs)
  });
  await ensureOk(response, rawUrl);
  return response.text();
}

export async function getTextViaUnblocker(
  signal: AbortSignal,
  rawUrl: string,
  init: Record<string, string> = {},
  timeoutMs = 60_000
) {
  const response = await fetch(rawUrl, {
    method: 'GET',
    headers: headers({
      'x-oxylabs-render': 'html',
      'x-oxylabs-geo-location': 'United States',
      ...init
    }),
    signal: withTimeout(signal, timeoutMs),
    dispatcher: unblockerAgent()
  } as RequestInit & { dispatcher: ProxyAgent });
  await ensureOk(response, rawUrl);
  return response.text();
}

export function normalizeMoney(raw?: string) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const numeric = Number.parseFloat(value.replace(/^\$/, '').replaceAll(',', ''));
  if (Number.isFinite(numeric) && numeric === 0) return '';
  return value.startsWith('$') ? value : `$${value}`;
}

export function formatCents(cents: number): string {
  const dollars = (cents / 100).toFixed(2);
  const [whole, fraction] = dollars.split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${withCommas}.${fraction}`;
}

export function priceToCents(raw?: string): number | null {
  const numeric = Number.parseFloat(
    String(raw ?? '')
      .trim()
      .replace(/^\$/, '')
      .replaceAll(',', '')
  );
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric * 100) : null;
}

export function extractUnitNumberValue(unitNumber?: string) {
  const digits = String(unitNumber ?? '').match(/\d+/g);
  return digits?.length ? Number.parseInt(digits.join(''), 10) : null;
}
