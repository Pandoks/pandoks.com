import type { Unit } from './scrapers/types';

export interface AlertRules {
  minPrice?: number;
  maxPrice?: number;
  unitNumbers?: string[];
  unitNumberMin?: number;
  unitNumberMax?: number;
  bedrooms?: number[];
  minFloor?: number;
  maxFloor?: number;
  moveInAfter?: string;
  moveInBefore?: string;
}

export interface Target {
  source: 'essex' | 'eqr';
  name: string;
  url: string;
  rules: AlertRules;
  watchUnits?: string[];
  eqrBuildingSlug?: string;
}

export interface AlertMatch {
  source: string;
  targetName: string;
  unit: Unit;
  change: 'new' | 'price_up' | 'price_down';
  previousPrice?: string;
  watched?: boolean;
  alreadySent?: string[];
}
