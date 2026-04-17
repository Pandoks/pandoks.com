import { getText, normalizeMoney, priceToCents } from './lib';
import type { Target } from '../types';
import type { Floorplan, TargetResult, Unit } from './types';

interface EssexEnvelope {
  result: EssexResult;
}

interface EssexResult {
  property_id: number;
  property_name: string;
  floorplans: EssexFloorplan[];
  units: EssexUnit[];
}

interface EssexFloorplan {
  floorplan_id: number;
  name: string;
  beds: string;
  baths: string;
  minimum_sqft: number;
  maximum_sqft: number;
  minimum_deposit: string;
  available_units_count: number;
  minimum_rent: string;
  maximum_rent: string;
  image_url: string;
}

interface EssexUnit {
  unit_id: number;
  floorplan_id: number;
  name: string;
  beds: string;
  baths: string;
  sqft: number;
  deposit: string;
  availability_date: string;
  minimum_rent: string;
}

const communityIdPattern = /data-communityid="(\d+)"/;

function buildApiUrl(pageUrl: string, propertyId: string, startDate: string, endDate: string) {
  const base = new URL(pageUrl).origin;
  return `${base}/EPT_Feature/PropertyManagement/Service/GetPropertyAvailabiltyByRange/${propertyId}/${startDate}/${endDate}`;
}

function parseResponse(body: string) {
  const encoded = JSON.parse(body) as string;
  return (JSON.parse(encoded) as EssexEnvelope).result;
}

function formatSqft(min: number, max: number) {
  if (min > 0 && max > 0 && min !== max) return `${min}-${max}`;
  return min > 0 ? String(min) : max > 0 ? String(max) : '';
}

function sortByPrice<T>(items: T[], price: (i: T) => string | undefined, name: (i: T) => string | undefined) {
  items.sort((a, b) => {
    const diff = priceToCents(price(a)) - priceToCents(price(b));
    return diff !== 0 ? diff : String(name(a) ?? '').localeCompare(String(name(b) ?? ''));
  });
}

export async function scrapeEssex(signal: AbortSignal, target: Target): Promise<TargetResult> {
  if (!target.url) throw new Error(`essex "${target.name}" missing url`);
  if (!target.startDate) throw new Error(`essex "${target.name}" missing startDate`);
  if (!target.endDate) throw new Error(`essex "${target.name}" missing endDate`);

  const pageHtml = await getText(signal, target.url, { accept: 'text/html,application/xhtml+xml' });
  const propertyId = pageHtml.match(communityIdPattern)?.[1];
  if (!propertyId) throw new Error(`essex "${target.name}" could not find communityId on page`);

  const apiUrl = buildApiUrl(target.url, propertyId, target.startDate, target.endDate);
  const body = await getText(signal, apiUrl, { accept: 'application/json' });
  const data = parseResponse(body);

  const floorplans: Floorplan[] = data.floorplans.map((fp) => ({
    id: String(fp.floorplan_id),
    name: fp.name,
    bedrooms: fp.beds,
    bathrooms: fp.baths,
    sqft: formatSqft(fp.minimum_sqft, fp.maximum_sqft),
    minPrice: normalizeMoney(fp.minimum_rent),
    maxPrice: normalizeMoney(fp.maximum_rent),
    deposit: normalizeMoney(fp.minimum_deposit),
    availableUnits: fp.available_units_count,
    imageUrl: fp.image_url
  }));

  const units: Unit[] = data.units.map((u) => ({
    id: String(u.unit_id),
    number: u.name,
    floorplanId: String(u.floorplan_id),
    bedrooms: u.beds,
    bathrooms: u.baths,
    sqft: String(u.sqft),
    price: normalizeMoney(u.minimum_rent),
    deposit: normalizeMoney(u.deposit),
    availableDate: u.availability_date?.trim()
  }));

  sortByPrice(floorplans, (f) => f.minPrice, (f) => f.name);
  sortByPrice(units, (u) => u.price, (u) => u.number);

  return {
    source: 'essex',
    name: target.name || data.property_name,
    summary: { availableFloorplans: floorplans.length, availableUnits: units.length },
    floorplans,
    units
  };
}
