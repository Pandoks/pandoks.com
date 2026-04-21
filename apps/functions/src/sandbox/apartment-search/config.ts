import type { AlertRules, Target } from './types';

const MOVE_IN_AFTER = '2026-05-18';
const MOVE_IN_BEFORE = '2026-06-01';

const BASE: AlertRules = {
  bedrooms: [0, 1],
  moveInAfter: MOVE_IN_AFTER,
  moveInBefore: MOVE_IN_BEFORE
};

const essexUrl = (slug: string) =>
  `https://www.essexapartmenthomes.com/apartments/sunnyvale/${slug}`;

export const TARGETS: Target[] = [
  {
    source: 'essex',
    name: '1250 Lakeside',
    url: essexUrl('1250-lakeside'),
    rules: { ...BASE, maxPrice: 3600 }
  },
  {
    source: 'essex',
    name: 'Reed Square',
    url: essexUrl('reed-square'),
    rules: { ...BASE, maxPrice: 2800 }
  },
  {
    source: 'eqr',
    name: 'The Arches',
    url: 'https://www.equityapartments.com/san-francisco-bay/sunnyvale/the-arches-apartments',
    eqrBuildingSlug: 'the-arches-2',
    rules: { ...BASE, maxPrice: 2800 }
  }
];
