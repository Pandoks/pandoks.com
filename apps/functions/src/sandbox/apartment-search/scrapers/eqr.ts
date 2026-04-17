import { getTextViaUnblocker, normalizeMoney, priceToCents } from './lib';
import type { Target } from '../types';
import type { Floorplan, TargetResult, Unit } from './types';

// Equity Residential embeds unit data as ea5.unitAvailability = {...} in a script tag
// This is a structured JSON object with all unit details

interface EqrData {
  BedroomTypes: EqrBedroomType[];
}

interface EqrBedroomType {
  Id: number;
  DisplayName: string;
  BedroomCount: number;
  AvailableUnits: EqrUnit[];
}

interface EqrUnit {
  LedgerId: string;
  UnitId: string;
  BuildingId: string;
  AvailableDate: string;
  BestTerm: { Length: number; Price: number };
  Terms: { Length: number; Price: number }[];
  SqFt: number;
  Bed: number;
  Bath: number;
  FloorplanId: string;
  FloorplanName: string;
  Floor: string;
  Description: string;
}

function extractUnitAvailability(html: string): EqrData {
  const marker = 'ea5.unitAvailability = ';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('could not find ea5.unitAvailability in page');

  const jsonStart = start + marker.length;

  // Find the end of the JSON object with brace counting
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

  return JSON.parse(html.slice(jsonStart, end)) as EqrData;
}

export async function scrapeEqr(signal: AbortSignal, target: Target): Promise<TargetResult> {
  if (!target.url) throw new Error(`eqr "${target.name}" missing url`);

  const body = await getTextViaUnblocker(signal, target.url, {
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'en-US,en;q=0.9'
  });

  const data = extractUnitAvailability(body);
  const floorplanMap = new Map<string, Floorplan>();
  const units: Unit[] = [];

  for (const bedroom of data.BedroomTypes) {
    for (const u of bedroom.AvailableUnits) {
      units.push({
        id: u.UnitId,
        number: u.UnitId,
        floorplanId: u.FloorplanId,
        floorplanName: u.FloorplanName,
        bedrooms: String(u.Bed),
        bathrooms: String(u.Bath),
        sqft: String(u.SqFt),
        price: normalizeMoney(String(u.BestTerm.Price)),
        availableDate: u.AvailableDate
      });

      // Build floorplan summary
      const fpKey = u.FloorplanId;
      if (!floorplanMap.has(fpKey)) {
        floorplanMap.set(fpKey, {
          id: u.FloorplanId,
          name: u.FloorplanName,
          bedrooms: String(u.Bed),
          bathrooms: String(u.Bath),
          sqft: String(u.SqFt),
          availableUnits: 0
        });
      }
      floorplanMap.get(fpKey)!.availableUnits! += 1;
    }
  }

  units.sort((a, b) => {
    const pa = priceToCents(a.price) ?? Infinity;
    const pb = priceToCents(b.price) ?? Infinity;
    const diff = pa - pb;
    return diff !== 0 ? diff : String(a.number ?? '').localeCompare(String(b.number ?? ''));
  });

  return {
    source: 'eqr',
    name: target.name || 'Equity Residential',
    summary: { availableFloorplans: floorplanMap.size, availableUnits: units.length },
    floorplans: [...floorplanMap.values()],
    units
  };
}
