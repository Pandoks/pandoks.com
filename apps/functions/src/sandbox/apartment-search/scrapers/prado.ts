import { extractJSArray, getText, parseLooseJSONArray, priceToCents } from './lib';
import type { Target } from '../types';
import type { Floorplan, TargetResult, Unit } from './types';

const DEFAULT_URL = 'https://www.liveprado.com/plans-availability/';

interface PradoFloorplan {
  fpName: string;
  fpID: number;
  fpBeds: number;
  fpBaths: number;
  fpSqft: string;
  fpMarketingName: string;
  fpImage: string;
}

interface PradoUnit {
  unitID: string;
  unitProviderId: string;
  unitNumber: string;
  unitCost: number;
  unitBasePrice: number;
  unitAvailable: string;
  unitPlanID: number;
  unitPlanName: string;
  unitBedrooms: number;
  unitBathrooms: number;
  unitSqft: string;
  unitLink: string;
}

export async function scrapePrado(signal: AbortSignal, target: Target): Promise<TargetResult> {
  const pageUrl = target.url || DEFAULT_URL;
  const body = await getText(signal, pageUrl, { accept: 'text/html,application/xhtml+xml' });

  const floorplanData = parseLooseJSONArray<PradoFloorplan[]>(extractJSArray(body, 'floorplans'));
  const unitData = parseLooseJSONArray<PradoUnit[]>(extractJSArray(body, 'liveAvailability'));

  const fpUnitCounts = new Map<number, number>();
  const fpDates = new Map<number, string[]>();
  const fpUrls = new Map<number, string>();

  for (const u of unitData) {
    fpUnitCounts.set(u.unitPlanID, (fpUnitCounts.get(u.unitPlanID) ?? 0) + 1);
    fpDates.set(u.unitPlanID, [...(fpDates.get(u.unitPlanID) ?? []), u.unitAvailable]);
    if (!fpUrls.has(u.unitPlanID) && u.unitLink) fpUrls.set(u.unitPlanID, u.unitLink);
  }

  const floorplans: Floorplan[] = floorplanData.map((fp) => ({
    id: String(fp.fpID),
    externalId: fp.fpName,
    name: fp.fpName,
    marketingName: fp.fpMarketingName,
    bedrooms: String(fp.fpBeds),
    bathrooms: String(fp.fpBaths),
    sqft: fp.fpSqft,
    availableUnits: fpUnitCounts.get(fp.fpID) ?? 0,
    availableDates: fpDates.get(fp.fpID) ?? [],
    imageUrl: fp.fpImage,
    applyUrl: fpUrls.get(fp.fpID)
  }));

  const units: Unit[] = unitData.map((u) => ({
    id: u.unitID,
    externalId: u.unitProviderId,
    number: u.unitNumber,
    floorplanId: String(u.unitPlanID),
    floorplanName: u.unitPlanName,
    bedrooms: String(u.unitBedrooms),
    bathrooms: String(u.unitBathrooms),
    sqft: u.unitSqft,
    price: `$${u.unitCost.toFixed(2)}`,
    basePrice: `$${u.unitBasePrice.toFixed(2)}`,
    availableDate: u.unitAvailable,
    applyUrl: u.unitLink
  }));

  units.sort((a, b) => {
    const diff = priceToCents(a.price) - priceToCents(b.price);
    return diff !== 0 ? diff : String(a.number ?? '').localeCompare(String(b.number ?? ''));
  });

  return {
    source: 'prado',
    name: target.name || 'Prado',
    summary: { availableFloorplans: floorplans.length, availableUnits: units.length },
    floorplans,
    units
  };
}
