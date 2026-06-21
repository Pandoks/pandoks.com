/**
 * Builds the Wear OS (android) watch app alongside the phone app on `pnpm android`.
 *
 * Watch sources live at apps/mobile-template/android-watch/, outside the
 * android/ tree that `expo prebuild --clean` wipes — but Gradle only looks
 * inside android/. During prebuild this plugin bridges that gap:
 *   1. Copies android-watch/ → android/wear/ so Gradle can find it.
 *   2. Registers `:wear` in settings.gradle so Gradle builds it.
 *   3. Adds the Kotlin Compose compiler plugin (Compose needs it on Kotlin 2.0+).
 */

import fs from 'fs';
import path from 'path';
import {
  withSettingsGradle,
  withProjectBuildGradle,
  withDangerousMod,
  createRunOncePlugin,
  type ConfigPlugin
} from 'expo/config-plugins';

const SOURCE_DIR = 'android-watch';
const MODULE_NAME = 'wear';

function wearSourceExists(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, SOURCE_DIR));
}

const withWearSettingsGradle: ConfigPlugin = (config) =>
  withSettingsGradle(config, (cfg) => {
    const contents = cfg.modResults.contents;
    if (
      !wearSourceExists(cfg.modRequest.projectRoot) ||
      contents.includes(`include ':${MODULE_NAME}'`)
    ) {
      return cfg;
    }

    cfg.modResults.contents = `
${contents}
include ':${MODULE_NAME}'
project(':${MODULE_NAME}').projectDir = new File(rootProject.projectDir, '${MODULE_NAME}')
`;
    return cfg;
  });

const COMPOSE_DEP = "classpath('org.jetbrains.kotlin:compose-compiler-gradle-plugin')";
const KOTLIN_PLUGIN = "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')";

const withComposeClasspath: ConfigPlugin = (config) =>
  withProjectBuildGradle(config, (cfg) => {
    if (
      !wearSourceExists(cfg.modRequest.projectRoot) ||
      cfg.modResults.contents.includes(COMPOSE_DEP)
    ) {
      return cfg;
    }

    cfg.modResults.contents = cfg.modResults.contents.replace(
      KOTLIN_PLUGIN,
      `${KOTLIN_PLUGIN}
    ${COMPOSE_DEP}`
    );
    return cfg;
  });

const withWearSourceCopy: ConfigPlugin = (config) =>
  withDangerousMod(config, [
    'android',
    (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      if (!wearSourceExists(projectRoot)) {
        return cfg;
      }
      const dest = path.join(projectRoot, 'android', MODULE_NAME);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(path.join(projectRoot, SOURCE_DIR), dest, { recursive: true });
      return cfg;
    }
  ]);

const withAndroidWatchModule: ConfigPlugin = (config) => {
  config = withWearSourceCopy(config);
  config = withWearSettingsGradle(config);
  config = withComposeClasspath(config);
  return config;
};

export default createRunOncePlugin(withAndroidWatchModule, 'android-watch', '1.0.0');
