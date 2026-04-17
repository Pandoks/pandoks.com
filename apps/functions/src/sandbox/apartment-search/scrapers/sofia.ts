import { extractFirst, getText, normalizeMoney, postForm, priceToCents, stripTags } from './lib';
import type { Target } from '../types';
import type { Floorplan, TargetResult, Unit } from './types';

const DEFAULT_URL = 'https://www.sofiaaptliving.com/floor-plans';
const TEMPLATE_URL = 'https://app.repli360.com/admin/template-render';
const UNIT_LIST_URL = 'https://app.repli360.com/admin/getUnitListByFloor';

const widgetScriptPattern = /(https:\/\/app\.repli360\.com\/admin\/rrac-website-script\/[^"' ]+)/;
const siteIdPattern = /var site_id = '([^']+)'/;
const moveInDatePattern = /var desiredMoveinDate = '([^']+)'/;
const cardPattern = /<div class="pro-sec rracFloorplan[\s\S]*?<\/ul><\/div><\/div>/g;
const dataIdPattern = /data-id="([^"]+)"/;
const dataFpNamePattern = /data-fpName="([^"]+)"/;
const bedPattern = /data-bed="([^"]+)"/;
const sizePattern = /data-size="([^"]+)"/;
const maxSizePattern = /data-max_size='([^']*)'/;
const minPricePattern = /data-min-price="([^"]+)"/;
const availableDatesPattern = /data-available-date= '([^']*)'/;
const imagePattern = /<img src="([^"]+)"/;
const titlePattern = /<h2>(.*?)<\/h2>/;
const detailKeyPattern = /getUnitListByFloor\(this,'([^']+)'/;
const applyUrlPattern = /<li><a href="([^"]+)">Apply Now<\/a><\/li>/;
const descriptionPattern = /<p>(.*?)<\/p>/;
const unitRowPattern = /<tr class="unitlisting[\s\S]*?<\/tr>/g;
const unitNumberPattern = /<b class="unitNumber">(.*?)<\/b>/;
const unitPricePattern = /<span class="unit_price_value unit-rrac-price">(.*?)<\/span>/;
const depositPattern = /<td><span>Deposit<\/span>(.*?)<\/td>/;
const availabilityPattern = /<td><span>Availability<\/span>(.*?)<\/td>/;
const unitApplyUrlPattern = /<a href="([^"]+)" id="goto_lease_/;
const rowDatePattern = /data-available_date="([^"]*)"/;
const bathsTextPattern = /\|\s*([0-9]+)\s*Bath/;
const unitCountPattern = /<span>([0-9]+)<\/span>\s*Units Available/;

function parseJsonStringArray(raw: string) {
  const value = raw.trim();
  if (!value) return [];
  try {
    return JSON.parse(value) as string[];
  } catch {
    return [];
  }
}

function firstNonEmpty(...values: Array<string | undefined>) {
  for (const v of values) if (v?.trim()) return v.trim();
  return '';
}

function parseSofiaUnitRows(raw: string, floorplanId: string): Unit[] {
  const rows = raw.match(unitRowPattern) ?? [];
  return rows
    .map((row) => {
      const number = stripTags(extractFirst(row, unitNumberPattern));
      if (!number) return null;
      return {
        id: number,
        number,
        floorplanId,
        price: stripTags(extractFirst(row, unitPricePattern)),
        deposit: stripTags(extractFirst(row, depositPattern)),
        availableDate: firstNonEmpty(
          extractFirst(row, rowDatePattern),
          stripTags(extractFirst(row, availabilityPattern))
        ),
        applyUrl: extractFirst(row, unitApplyUrlPattern)
      } satisfies Unit;
    })
    .filter((u): u is Unit => u !== null);
}

function parseSofiaFloorplans(raw: string) {
  const cards = raw.match(cardPattern) ?? [];
  const floorplans: Floorplan[] = [];
  const detailKeys: string[] = [];
  const seen = new Set<string>();

  for (const card of cards) {
    const detailKey = extractFirst(card, detailKeyPattern);
    if (!detailKey || seen.has(detailKey)) continue;

    const availableUnits = Number.parseInt(extractFirst(card, unitCountPattern), 10) || 0;
    const availableDates = parseJsonStringArray(extractFirst(card, availableDatesPattern));
    if (!availableUnits && !availableDates.length) continue;

    seen.add(detailKey);

    const size = extractFirst(card, sizePattern);
    const maxSize = extractFirst(card, maxSizePattern);
    const sqft = size && maxSize && size !== maxSize ? `${size}-${maxSize}` : size || maxSize;
    const description = extractFirst(card, descriptionPattern);

    floorplans.push({
      id: detailKey,
      externalId: extractFirst(card, dataIdPattern),
      name: extractFirst(card, titlePattern),
      marketingName: extractFirst(card, dataFpNamePattern),
      bedrooms: extractFirst(card, bedPattern),
      bathrooms: extractFirst(description, bathsTextPattern),
      sqft,
      minPrice: normalizeMoney(extractFirst(card, minPricePattern)),
      availableUnits,
      availableDates,
      imageUrl: extractFirst(card, imagePattern),
      applyUrl: extractFirst(card, applyUrlPattern)
    });

    detailKeys.push(detailKey);
  }

  return { floorplans, detailKeys };
}

function dedupeUnits(units: Unit[]) {
  const seen = new Set<string>();
  return units.filter((u) => {
    const key = `${u.floorplanId ?? ''}|${u.number ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function scrapeSofia(signal: AbortSignal, target: Target): Promise<TargetResult> {
  const pageUrl = target.url || DEFAULT_URL;
  const pageHtml = await getText(signal, pageUrl, { accept: 'text/html,application/xhtml+xml' });

  const widgetUrl = extractFirst(pageHtml, widgetScriptPattern);
  if (!widgetUrl) throw new Error('could not find Sofia widget script');

  const widgetScript = await getText(signal, widgetUrl, { accept: '*/*' });
  const siteId = extractFirst(widgetScript, siteIdPattern);
  if (!siteId) throw new Error('could not find Sofia siteId');

  const moveInDate = target.moveInDate || extractFirst(widgetScript, moveInDatePattern);
  const templateBody = await postForm(
    signal,
    TEMPLATE_URL,
    new URLSearchParams({ site_id: siteId }),
    {
      accept: '*/*',
      origin: 'https://www.sofiaaptliving.com',
      referer: pageUrl
    }
  );

  const { floorplans, detailKeys } = parseSofiaFloorplans(templateBody);
  let units: Unit[] = [];

  if (moveInDate) {
    const unitResults = await Promise.all(
      detailKeys.map(async (key) => {
        const body = await postForm(
          signal,
          UNIT_LIST_URL,
          new URLSearchParams({
            floorPlanID: key,
            moveinDate: moveInDate,
            site_id: siteId,
            template_type: '2'
          }),
          { accept: '*/*', origin: 'https://www.sofiaaptliving.com', referer: pageUrl }
        );
        const payload = JSON.parse(body) as { str: string };
        return parseSofiaUnitRows(payload.str, key);
      })
    );
    const fpLookup = new Map(floorplans.map((fp) => [fp.id, fp]));
    units = dedupeUnits(unitResults.flat()).map((u) => {
      const fp = fpLookup.get(u.floorplanId);
      if (!fp) return u;
      return {
        ...u,
        floorplanName: u.floorplanName || fp.name,
        bedrooms: u.bedrooms || fp.bedrooms,
        bathrooms: u.bathrooms || fp.bathrooms,
        sqft: u.sqft || fp.sqft
      };
    });
  }

  const sortByPrice = <T>(
    items: T[],
    price: (i: T) => string | undefined,
    name: (i: T) => string | undefined
  ) =>
    items.sort((a, b) => {
      const diff = priceToCents(price(a)) - priceToCents(price(b));
      return diff !== 0 ? diff : String(name(a) ?? '').localeCompare(String(name(b) ?? ''));
    });

  sortByPrice(
    floorplans,
    (f) => f.minPrice,
    (f) => f.name
  );
  sortByPrice(
    units,
    (u) => u.price,
    (u) => u.number
  );

  return {
    source: 'sofia',
    name: target.name || 'Sofia',
    summary: { availableFloorplans: floorplans.length, availableUnits: units.length },
    floorplans,
    units
  };
}
