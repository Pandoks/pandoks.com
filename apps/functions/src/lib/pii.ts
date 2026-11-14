import { env } from 'cloudflare:workers';

export const PHONE_NUMBER_MAPPINGS = {
  'Manda Wong': env.MICHELLE_PHONE_NUMBER,
  'BLAINE Manda Wong': env.MICHELLE_PHONE_NUMBER,
  Pandoks: env.KWOK_PHONE_NUMBER
};
export type Users = keyof typeof PHONE_NUMBER_MAPPINGS;
