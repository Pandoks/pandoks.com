import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext } from 'expo/config';

const GOOGLE_SERVICES_FILE = './.expo/google-services.json';

// NOTE: set GOOGLE_SERVICES_JSON to the Firebase app's google-services.json contents to enable FCM
const googleServicesJson = process.env.GOOGLE_SERVICES_JSON;

export default ({ config, projectRoot }: ConfigContext) => {
  if (!googleServicesJson) {
    return config;
  }
  mkdirSync(join(projectRoot, '.expo'), { recursive: true });
  writeFileSync(join(projectRoot, GOOGLE_SERVICES_FILE), googleServicesJson);
  return { ...config, android: { ...config.android, googleServicesFile: GOOGLE_SERVICES_FILE } };
};
