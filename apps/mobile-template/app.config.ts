import { writeFileSync } from 'node:fs';
import type { ConfigContext } from 'expo/config';

const GOOGLE_SERVICES_FILE = './google-services.json';

// NOTE: `sst shell --stage <stage>` sets this to the stage's Firebase app, so only those builds get an FCM token
const firebaseAndroidConfig = process.env.SST_RESOURCE_FirebaseMobileTemplateAndroidConfig;

export default ({ config }: ConfigContext) => {
  if (!firebaseAndroidConfig) {
    return config;
  }
  const { googleServicesJson } = JSON.parse(firebaseAndroidConfig) as {
    googleServicesJson: string;
  };
  writeFileSync(GOOGLE_SERVICES_FILE, googleServicesJson);
  return { ...config, android: { ...config.android, googleServicesFile: GOOGLE_SERVICES_FILE } };
};
