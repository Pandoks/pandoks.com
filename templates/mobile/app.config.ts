import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext } from 'expo/config';

const GOOGLE_SERVICES_FILE = './.expo/google-services.json';

// NOTE: `sst shell --stage <stage>` sets this to the stage's Firebase app, so only those builds get an FCM token
const firebaseAndroidConfig = process.env.SST_RESOURCE_FirebaseMobileTemplateAndroidConfig;

export default ({ config, projectRoot }: ConfigContext) => {
  if (!firebaseAndroidConfig) {
    return config;
  }
  const { googleServicesJson } = JSON.parse(firebaseAndroidConfig) as {
    googleServicesJson: string;
  };
  mkdirSync(join(projectRoot, '.expo'), { recursive: true });
  writeFileSync(join(projectRoot, GOOGLE_SERVICES_FILE), googleServicesJson);
  return { ...config, android: { ...config.android, googleServicesFile: GOOGLE_SERVICES_FILE } };
};
