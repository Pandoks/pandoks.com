import { AndroidConfig, withAndroidManifest, withInfoPlist } from 'expo/config-plugins';

/** @type {import('expo/config-plugins').ConfigPlugin<{ greeting: string }>} */
export default function withModuleTemplate(config, { greeting }) {
  config = withInfoPlist(config, (plistConfig) => {
    plistConfig.modResults.ModuleTemplateGreeting = greeting;
    return plistConfig;
  });
  return withAndroidManifest(config, (manifestConfig) => {
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      AndroidConfig.Manifest.getMainApplicationOrThrow(manifestConfig.modResults),
      'ModuleTemplateGreeting',
      greeting
    );
    return manifestConfig;
  });
}
