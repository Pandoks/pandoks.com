import type { Target } from '../types';
import type { TargetResult } from './types';
import { scrapeEssex } from './essex';
import { scrapeEqr } from './eqr';

type Scraper = (signal: AbortSignal, target: Target) => Promise<TargetResult>;

const SCRAPERS: Record<Target['source'], Scraper> = {
  essex: scrapeEssex,
  eqr: scrapeEqr
};

export interface ScrapeFailure {
  target: string;
  reason: unknown;
}

export async function scrapeTarget(target: Target, timeoutMs = 20_000): Promise<TargetResult> {
  const scraper = SCRAPERS[target.source];
  if (!scraper) throw new Error(`unsupported source "${target.source}"`);
  return scraper(AbortSignal.timeout(timeoutMs), target);
}

export async function scrapeAll(
  targets: Target[],
  timeoutMs = 20_000
): Promise<{ results: TargetResult[]; failures: ScrapeFailure[] }> {
  const settled = await Promise.allSettled(targets.map((t) => scrapeTarget(t, timeoutMs)));

  const results: TargetResult[] = [];
  const failures: ScrapeFailure[] = [];

  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === 'fulfilled') {
      results.push(r.value);
    } else {
      console.error('Scrape failed', { target: targets[i].name, error: r.reason });
      failures.push({ target: targets[i].name, reason: r.reason });
      results.push({
        source: targets[i].source,
        name: targets[i].name,
        summary: { availableFloorplans: 0, availableUnits: 0 },
        floorplans: [],
        units: []
      });
    }
  }

  return { results, failures };
}
