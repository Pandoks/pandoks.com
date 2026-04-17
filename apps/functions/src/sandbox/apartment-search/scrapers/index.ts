import type { Target } from '../types';
import type { TargetResult } from './types';
import { scrapeEssex } from './essex';
import { scrapePrado } from './prado';
import { scrapeSofia } from './sofia';
import { scrapeUdr } from './udr';
import { scrapeEqr } from './eqr';

type Scraper = (signal: AbortSignal, target: Target) => Promise<TargetResult>;

const SCRAPERS: Record<string, Scraper> = {
  essex: scrapeEssex,
  prado: scrapePrado,
  sofia: scrapeSofia,
  udr: scrapeUdr,
  eqr: scrapeEqr
};

export async function scrapeTarget(target: Target, timeoutMs = 20_000): Promise<TargetResult> {
  const scraper = SCRAPERS[target.source];
  if (!scraper) throw new Error(`unsupported source "${target.source}"`);
  return scraper(AbortSignal.timeout(timeoutMs), target);
}

export async function scrapeAll(targets: Target[], timeoutMs = 20_000): Promise<TargetResult[]> {
  const results = await Promise.allSettled(targets.map((t) => scrapeTarget(t, timeoutMs)));

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.error('Scrape failed', { target: targets[i].name, error: r.reason });
    return {
      source: targets[i].source,
      name: targets[i].name,
      summary: { availableFloorplans: 0, availableUnits: 0 },
      floorplans: [],
      units: []
    };
  });
}
