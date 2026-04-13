import { Resource } from 'sst';

export const PHONE_NUMBER_MAPPINGS = {
  'Manda Wong': Resource.MichellePhoneNumber.value,
  'BLAINE Manda Wong': Resource.MichellePhoneNumber.value,
  Pandoks: Resource.KwokPhoneNumber.value
};
export type Users = keyof typeof PHONE_NUMBER_MAPPINGS;
