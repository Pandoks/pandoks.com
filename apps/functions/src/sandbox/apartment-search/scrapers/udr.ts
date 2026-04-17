import { getText, normalizeMoney, priceToCents } from './lib';
import type { Target } from '../types';
import type { Floorplan, TargetResult, Unit } from './types';

// UDR embeds all data as window.udr.jsonObjPropertyViewModel in the HTML
// This is a proper JSON object (not loose JS), so we can parse directly

interface UdrData {
  propertyId: number;
  propertyName: string;
  floorPlans: UdrFloorPlan[];
  unavailableFloorPlans: UdrFloorPlan[];
}

interface UdrFloorPlan {
  id: number;
  Name: string;
  bedRooms: number;
  bathRooms: number;
  sqFtMin: number;
  sqFtMax: number;
  rentMin: number;
  rentMax: number;
  deposit: string;
  earliestMoveInDate: string;
  listingImage?: { src: string };
  units: UdrUnit[];
}

interface UdrUnit {
  apartmentId: number;
  marketingName: string;
  bedrooms: number;
  bathrooms: number;
  sqFt: number;
  rent: number;
  rentMin: number;
  rentMax: number;
  deposit: number;
  isAvailable: boolean;
  availableDate: string;
  floorplanId: number;
  floorplanName: string;
  AvailableDateLabel: string;
  previewLink: string;
}

/** Parse ASP.NET date format /Date(1776211200000)/ → ISO string */
function parseAspNetDate(raw?: string): string {
  if (!raw) return '';
  const match = raw.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
  if (!match?.[1]) return raw;
  return new Date(Number.parseInt(match[1], 10)).toISOString();
}

function extractViewModel(html: string): UdrData {
  // The data is assigned as: window.udr.jsonObjPropertyViewModel = {...};
  const marker = 'window.udr.jsonObjPropertyViewModel = ';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('could not find UDR view model in page');

  const jsonStart = start + marker.length;

  // Find the matching closing brace using a simple counter
  let depth = 0;
  let end = jsonStart;
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') depth--;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }

  return JSON.parse(html.slice(jsonStart, end)) as UdrData;
}

function formatSqft(min: number, max: number) {
  if (min > 0 && max > 0 && min !== max) return `${min}-${max}`;
  return min > 0 ? String(min) : max > 0 ? String(max) : '';
}

export async function scrapeUdr(signal: AbortSignal, target: Target): Promise<TargetResult> {
  if (!target.url) throw new Error(`udr "${target.name}" missing url`);

  // UDR serves apartment data on the /apartments-pricing/ page
  const pageUrl = target.url.endsWith('/apartments-pricing/')
    ? target.url
    : `${target.url.replace(/\/$/, '')}/apartments-pricing/`;

  const body = await getText(signal, pageUrl, { accept: 'text/html,application/xhtml+xml' });
  const data = extractViewModel(body);

  const floorplans: Floorplan[] = data.floorPlans.map((fp) => ({
    id: String(fp.id),
    name: fp.Name,
    bedrooms: String(fp.bedRooms),
    bathrooms: String(fp.bathRooms),
    sqft: formatSqft(fp.sqFtMin, fp.sqFtMax),
    minPrice: normalizeMoney(String(fp.rentMin)),
    maxPrice: normalizeMoney(String(fp.rentMax)),
    deposit: normalizeMoney(fp.deposit),
    availableUnits: fp.units.filter((u) => u.isAvailable).length,
    imageUrl: fp.listingImage?.src
  }));

  const units: Unit[] = data.floorPlans.flatMap((fp) =>
    fp.units
      .filter((u) => u.isAvailable)
      .map((u) => ({
        id: String(u.apartmentId),
        number: u.marketingName,
        floorplanId: String(u.floorplanId),
        floorplanName: u.floorplanName,
        bedrooms: String(u.bedrooms),
        bathrooms: String(u.bathrooms),
        sqft: String(u.sqFt),
        price: normalizeMoney(String(u.rent)),
        deposit: normalizeMoney(String(u.deposit)),
        availableDate: parseAspNetDate(u.availableDate) || u.AvailableDateLabel
      }))
  );

  units.sort((a, b) => {
    const pa = priceToCents(a.price) ?? Infinity;
    const pb = priceToCents(b.price) ?? Infinity;
    const diff = pa - pb;
    return diff !== 0 ? diff : String(a.number ?? '').localeCompare(String(b.number ?? ''));
  });

  return {
    source: 'udr',
    name: target.name || data.propertyName,
    summary: { availableFloorplans: floorplans.length, availableUnits: units.length },
    floorplans,
    units
  };
}
