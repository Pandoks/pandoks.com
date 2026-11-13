import { withSettingsGradle } from 'expo/config-plugins';

/** @type {import('expo/config-plugins').ConfigPlugin<{ wearApp: string }>} */
export default function withWatch(config, { wearApp }) {
  return withSettingsGradle(config, (settingsConfig) => {
    const include = `include ':wear'\nproject(':wear').projectDir = new File(rootDir.parentFile, '${wearApp}')\n`;
    if (!settingsConfig.modResults.contents.includes(include)) {
      settingsConfig.modResults.contents += `\n${include}`;
    }
    return settingsConfig;
  });
}
