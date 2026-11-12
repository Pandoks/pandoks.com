export const PHONE_NUMBER_MAPPINGS = {
  'Manda Wong': process.env.MICHELLE_PHONE_NUMBER!,
  'BLAINE Manda Wong': process.env.MICHELLE_PHONE_NUMBER!,
  Pandoks: process.env.KWOK_PHONE_NUMBER!
};
export type Users = keyof typeof PHONE_NUMBER_MAPPINGS;
