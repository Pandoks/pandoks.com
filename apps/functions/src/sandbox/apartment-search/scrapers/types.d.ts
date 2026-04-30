export interface TargetResult {
  source: string;
  name: string;
  summary: Summary;
  floorplans: Floorplan[];
  units: Unit[];
}

export interface Summary {
  availableFloorplans: number;
  availableUnits: number;
  cheapestUnit?: string;
  cheapestPrice?: string;
}

export interface Floorplan {
  id?: string;
  externalId?: string;
  name?: string;
  marketingName?: string;
  bedrooms?: string;
  bathrooms?: string;
  sqft?: string;
  minPrice?: string;
  maxPrice?: string;
  deposit?: string;
  availableUnits?: number;
  availableDates?: string[];
  imageUrl?: string;
  applyUrl?: string;
}

export interface Unit {
  id?: string;
  externalId?: string;
  number?: string;
  floorplanId?: string;
  floorplanName?: string;
  bedrooms?: string;
  bathrooms?: string;
  sqft?: string;
  price?: string;
  basePrice?: string;
  deposit?: string;
  availableDate?: string;
  priceDate?: string;
  applyUrl?: string;
}
