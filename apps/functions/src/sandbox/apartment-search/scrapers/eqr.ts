import { formatCents, getTextViaUnblocker, normalizeMoney, priceToCents } from './lib';
import type { Target } from '../types';
import type { Floorplan, TargetResult, Unit } from './types';

interface EqrPrice {
  dateAvailable: string;
  rent: number;
  leaseTermLength: number;
  price_token: string;
}

interface EqrUnit {
  id: string;
  unit_number: string;
  number_of_bedrooms: number;
  number_of_bathrooms: number;
  square_footage: number;
  floor: number;
  floorplan_name: string;
  date_available: string;
  rent: number;
  price_matrix?: { prices?: EqrPrice[] };
}

export async function scrapeEqr(signal: AbortSignal, target: Target): Promise<TargetResult> {
  if (!target.eqrBuildingSlug) {
    throw new Error(`eqr "${target.name}" missing eqrBuildingSlug`);
  }
  const { moveInAfter, moveInBefore } = target.rules;
  if (!moveInAfter || !moveInBefore) {
    throw new Error(`eqr "${target.name}" requires rules.moveInAfter and rules.moveInBefore`);
  }

  const apiUrl = `https://eqr-applications.com/api/searchUnits?building_slug=${encodeURIComponent(
    target.eqrBuildingSlug
  )}&include_price=true&include_max_occupancy=true`;

  const body = await getTextViaUnblocker(signal, apiUrl, { accept: 'application/json' });
  const rawUnits = JSON.parse(body) as EqrUnit[];

  const floorplanMap = new Map<string, Floorplan>();
  const units: Unit[] = [];

  for (const u of rawUnits) {
    let best: EqrPrice | null = null;
    for (const p of u.price_matrix?.prices ?? []) {
      if (p.leaseTermLength !== 12) continue;
      if (p.dateAvailable < moveInAfter || p.dateAvailable > moveInBefore) continue;
      if (!best || p.rent < best.rent) best = p;
    }
    if (!best) continue;

    units.push({
      id: u.id,
      number: u.unit_number,
      floorplanId: u.floorplan_name,
      floorplanName: u.floorplan_name,
      bedrooms: String(u.number_of_bedrooms),
      bathrooms: String(u.number_of_bathrooms),
      sqft: String(u.square_footage),
      price: normalizeMoney(String(best.rent)),
      availableDate: best.dateAvailable,
      priceDate: best.dateAvailable
    });

    if (!floorplanMap.has(u.floorplan_name)) {
      floorplanMap.set(u.floorplan_name, {
        id: u.floorplan_name,
        name: u.floorplan_name,
        bedrooms: String(u.number_of_bedrooms),
        bathrooms: String(u.number_of_bathrooms),
        sqft: String(u.square_footage),
        availableUnits: 0
      });
    }
    floorplanMap.get(u.floorplan_name)!.availableUnits! += 1;
  }

  const centsByFloorplan = new Map<string, number[]>();
  for (const u of units) {
    const cents = priceToCents(u.price);
    if (cents == null || !u.floorplanId) continue;
    const bucket = centsByFloorplan.get(u.floorplanId) ?? [];
    bucket.push(cents);
    centsByFloorplan.set(u.floorplanId, bucket);
  }
  const floorplans = [...floorplanMap.values()].map((fp) => {
    const cents = fp.id ? centsByFloorplan.get(fp.id) : undefined;
    if (!cents?.length) return fp;
    return {
      ...fp,
      minPrice: formatCents(Math.min(...cents)),
      maxPrice: formatCents(Math.max(...cents))
    };
  });

  units.sort((a, b) => {
    const diff = (priceToCents(a.price) ?? Infinity) - (priceToCents(b.price) ?? Infinity);
    return diff !== 0 ? diff : String(a.number ?? '').localeCompare(String(b.number ?? ''));
  });

  return {
    source: 'eqr',
    name: target.name,
    summary: { availableFloorplans: floorplans.length, availableUnits: units.length },
    floorplans,
    units
  };
}
