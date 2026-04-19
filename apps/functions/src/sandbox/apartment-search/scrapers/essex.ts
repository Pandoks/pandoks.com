import { formatCents, getText, normalizeMoney, priceToCents } from './lib';
import {
  discoverSightmapContext,
  getCheapestInWindow,
  normalizeUnitNumber,
  type SightmapContext
} from './sightmap';
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

interface LegacyEssexData {
  propertyName: string;
  units: Unit[];
  floorplans: Floorplan[];
}

const communityIdPattern = /data-communityid="(\d+)"/;

function sortByPrice<T>(
  items: T[],
  price: (i: T) => string | undefined,
  name: (i: T) => string | undefined
) {
  items.sort((a, b) => {
    const pa = priceToCents(price(a)) ?? Infinity;
    const pb = priceToCents(price(b)) ?? Infinity;
    const diff = pa - pb;
    return diff !== 0 ? diff : String(name(a) ?? '').localeCompare(String(name(b) ?? ''));
  });
}

async function fetchEssexLegacy(signal: AbortSignal, target: Target): Promise<LegacyEssexData> {
  const { moveInAfter, moveInBefore } = target.rules;
  if (!moveInAfter || !moveInBefore) {
    throw new Error(`essex "${target.name}" requires rules.moveInAfter and rules.moveInBefore`);
  }

  const pageHtml = await getText(signal, target.url, { accept: 'text/html,application/xhtml+xml' });
  const propertyId = pageHtml.match(communityIdPattern)?.[1];
  if (!propertyId) throw new Error(`essex "${target.name}" could not find communityId on page`);

  const origin = new URL(target.url).origin;
  const apiUrl = `${origin}/EPT_Feature/PropertyManagement/Service/GetPropertyAvailabiltyByRange/${propertyId}/${moveInAfter}/${moveInBefore}`;
  const body = await getText(signal, apiUrl, { accept: 'application/json' });
  const data = (JSON.parse(JSON.parse(body) as string) as EssexEnvelope).result;

  const floorplans: Floorplan[] = data.floorplans.map((fp) => {
    const sqft =
      fp.minimum_sqft > 0 && fp.maximum_sqft > 0 && fp.minimum_sqft !== fp.maximum_sqft
        ? `${fp.minimum_sqft}-${fp.maximum_sqft}`
        : fp.minimum_sqft > 0
          ? String(fp.minimum_sqft)
          : fp.maximum_sqft > 0
            ? String(fp.maximum_sqft)
            : '';
    return {
      id: String(fp.floorplan_id),
      name: fp.name,
      bedrooms: fp.beds,
      bathrooms: fp.baths,
      sqft,
      minPrice: normalizeMoney(fp.minimum_rent),
      maxPrice: normalizeMoney(fp.maximum_rent),
      deposit: normalizeMoney(fp.minimum_deposit),
      availableUnits: fp.available_units_count,
      imageUrl: fp.image_url
    };
  });

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

  return { propertyName: data.property_name, units, floorplans };
}

async function enrichUnitsWithSightmap(
  signal: AbortSignal,
  ctx: SightmapContext,
  units: Unit[],
  windowStart: string,
  windowEnd: string,
  targetName: string
): Promise<Unit[]> {
  const enriched = await Promise.all(
    units.map(async (u): Promise<Unit | null> => {
      const sightmapUnitId = ctx.unitIdByNumber.get(normalizeUnitNumber(u.number));
      if (!sightmapUnitId) {
        console.warn(`essex "${targetName}" unit ${u.number} not found in sightmap — dropping`);
        return null;
      }
      const best = await getCheapestInWindow(signal, ctx, sightmapUnitId, windowStart, windowEnd);
      if (!best) return null;
      return { ...u, price: best.price, availableDate: best.date, priceDate: best.date };
    })
  );
  return enriched.filter((u): u is Unit => u !== null);
}

function rederiveFloorplans(floorplans: Floorplan[], units: Unit[]): Floorplan[] {
  const byFloorplanId = new Map<string, Unit[]>();
  for (const u of units) {
    const id = u.floorplanId;
    if (!id) continue;
    const bucket = byFloorplanId.get(id);
    if (bucket) bucket.push(u);
    else byFloorplanId.set(id, [u]);
  }

  return floorplans.map((fp) => {
    const fpUnits = fp.id ? byFloorplanId.get(fp.id) : undefined;
    if (!fpUnits?.length) return { ...fp, availableUnits: 0 };
    const cents = fpUnits.map((u) => priceToCents(u.price)).filter((n): n is number => n != null);
    if (!cents.length) return { ...fp, availableUnits: fpUnits.length };
    return {
      ...fp,
      minPrice: formatCents(Math.min(...cents)),
      maxPrice: formatCents(Math.max(...cents)),
      availableUnits: fpUnits.length
    };
  });
}

export async function scrapeEssex(signal: AbortSignal, target: Target): Promise<TargetResult> {
  const { moveInAfter, moveInBefore } = target.rules;
  if (!moveInAfter || !moveInBefore) {
    throw new Error(`essex "${target.name}" requires rules.moveInAfter and rules.moveInBefore`);
  }

  const [legacy, sightmapCtx] = await Promise.all([
    fetchEssexLegacy(signal, target),
    discoverSightmapContext(signal, target.url)
  ]);

  if (!sightmapCtx.leasingToken) {
    throw new Error(`essex "${target.name}" sightmap context has no leasingToken`);
  }

  const units = await enrichUnitsWithSightmap(
    signal,
    sightmapCtx,
    legacy.units,
    moveInAfter,
    moveInBefore,
    target.name
  );
  const floorplans = rederiveFloorplans(legacy.floorplans, units);

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
    source: 'essex',
    name: target.name || legacy.propertyName,
    summary: { availableFloorplans: floorplans.length, availableUnits: units.length },
    floorplans,
    units
  };
}
