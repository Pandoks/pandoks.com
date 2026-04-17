import type { AlertRules, Target } from './types';

const MOVE_IN_START = '2026-05-18';
const MOVE_IN_END = '2026-06-01';

export const DEFAULT_RULES: AlertRules = {
  maxPrice: 2800,
  bedrooms: [0, 1],
  moveInAfter: MOVE_IN_START,
  moveInBefore: MOVE_IN_END
};

const essexUrl = (slug: string) =>
  `https://www.essexapartmenthomes.com/apartments/sunnyvale/${slug}`;

const APARTMENTS: { source: string; name: string; url: string; watchUnits?: string[] }[] = [
  { source: 'essex', name: '1250 Lakeside', url: essexUrl('1250-lakeside') },
  { source: 'essex', name: 'The Montclaire', url: essexUrl('the-montclaire') },
  { source: 'essex', name: 'Reed Square', url: essexUrl('reed-square') },
  { source: 'essex', name: 'Lawrence Station', url: essexUrl('lawrence-station') },
  { source: 'essex', name: 'Bristol Commons', url: essexUrl('bristol-commons') },
  { source: 'essex', name: 'Summerhill Park', url: essexUrl('summerhill-park') },
  { source: 'prado', name: 'Prado', url: 'https://www.liveprado.com/plans-availability/' },
  { source: 'sofia', name: 'Sofia', url: 'https://www.sofiaaptliving.com/floor-plans' },
  {
    source: 'udr',
    name: 'Marina Playa',
    url: 'https://www.udr.com/san-francisco-bay-area-apartments/santa-clara/marina-playa/'
  },
  {
    source: 'eqr',
    name: 'The Arches',
    url: 'https://www.equityapartments.com/san-francisco-bay/sunnyvale/the-arches-apartments'
  }
];

export const TARGETS: Target[] = APARTMENTS.map((apt) => ({
  ...apt,
  startDate: MOVE_IN_START,
  endDate: MOVE_IN_END,
  moveInDate: MOVE_IN_START
}));
