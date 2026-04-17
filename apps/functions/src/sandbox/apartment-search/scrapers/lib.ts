import { ProxyAgent } from 'undici';
import { Resource } from 'sst';

const USER_AGENT = 'apartment-scraper/1.0';

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
      token
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

export async function postForm(
  signal: AbortSignal,
  rawUrl: string,
  form: URLSearchParams,
  init: Record<string, string> = {},
  timeoutMs = 15_000
) {
  const response = await fetch(rawUrl, {
    method: 'POST',
    headers: headers({
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...init
    }),
    body: form,
    signal: withTimeout(signal, timeoutMs)
  });
  await ensureOk(response, rawUrl);
  return response.text();
}

function decodeHtml(raw: string) {
  return raw
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function stripTags(raw: string) {
  return decodeHtml(raw.replace(/<[^>]+>/g, ' '))
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

export function extractFirst(raw: string, pattern: RegExp) {
  return decodeHtml(raw.match(pattern)?.[1]?.trim() ?? '');
}

export function normalizeMoney(raw?: string) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const numeric = Number.parseFloat(value.replace(/^\$/, '').replaceAll(',', ''));
  if (Number.isFinite(numeric) && numeric === 0) return '';
  return value.startsWith('$') ? value : `$${value}`;
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractJSArray(html: string, variableName: string) {
  const pattern = new RegExp(`${escapeRegExp(variableName)}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`, 's');
  const match = html.match(pattern);
  if (!match?.[1]) throw new Error(`could not find ${variableName} array`);
  return match[1];
}

export function parseLooseJSONArray<T>(raw: string) {
  return JSON.parse(
    raw
      .replace(/([{\[,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
      .replace(/,(\s*[}\]])/g, '$1')
      .trim()
  ) as T;
}
