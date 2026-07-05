/**
 * Wires app-owned Glance widgets into the Android project on `expo prebuild`.
 *
 * Widget sources live at apps/<app>/android-widget/, outside the android/ tree
 * that `expo prebuild --clean` wipes. During prebuild this plugin:
 *   1. Copies android-widget/kotlin/ → android/app/src/main/java/<package>/widgets/,
 *      rewriting the `com.example` placeholder package to the app's package.
 *   2. Copies android-widget/res/ (if present) and generates each widget's
 *      appwidget-provider info XML + label/description strings from the plugin config.
 *   3. Registers a <receiver> per widget in AndroidManifest.xml
 *      (naming contract: <package>.widgets.<Name>WidgetReceiver).
 *   4. Adds the Kotlin Compose compiler plugin to :app (Glance UI is @Composable
 *      code compiled into the app module; Compose needs it on Kotlin 2.0+).
 *
 * NOTE: single file on purpose — expo transpiles only the entry TS plugin file,
 * so a relative import of another .ts module would fail at plugin load time.
 */

import fs from 'fs';
import path from 'path';
import {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withProjectBuildGradle,
  type ConfigPlugin
} from 'expo/config-plugins';

export interface WidgetAndroidWidget {
  name: string;
  displayName: string;
  description: string;
  minWidth?: number;
  minHeight?: number;
  targetCellWidth?: number;
  targetCellHeight?: number;
  resizeMode?: 'none' | 'horizontal' | 'vertical' | 'both';
}

export interface WidgetAndroidProps {
  widgets: WidgetAndroidWidget[];
}

type ManifestReceiver = NonNullable<AndroidConfig.Manifest.ManifestApplication['receiver']>[number];
export type WidgetReceiver = Omit<ManifestReceiver, '$'> & {
  $: ManifestReceiver['$'] & { 'android:label'?: string };
  'meta-data'?: AndroidConfig.Manifest.ManifestMetaData[];
};

// Marker meta-data so re-running prebuild replaces our receivers instead of duplicating them
export const WIDGET_NAME_METADATA = 'com.pandoks.widgetandroid.NAME';

const SOURCE_DIR = 'android-widget';
const PLACEHOLDER_PACKAGE = 'com.example';
const STRINGS_FILE = 'widget_android_strings.xml';

export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
}

export function receiverClassName(widget: WidgetAndroidWidget): string {
  return `${widget.name}WidgetReceiver`;
}

export function infoResourceName(widget: WidgetAndroidWidget): string {
  return `widget_${snakeCase(widget.name)}_info`;
}

export function labelResourceName(widget: WidgetAndroidWidget): string {
  return `widget_${snakeCase(widget.name)}_label`;
}

export function descriptionResourceName(widget: WidgetAndroidWidget): string {
  return `widget_${snakeCase(widget.name)}_description`;
}

function resizeModeAttribute(widget: WidgetAndroidWidget): string {
  return widget.resizeMode === undefined ? 'horizontal|vertical' : widget.resizeMode;
}

export function createWidgetInfoXml(widget: WidgetAndroidWidget): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
  android:minWidth="${widget.minWidth ?? 180}dp"
  android:minHeight="${widget.minHeight ?? 110}dp"
  android:targetCellWidth="${widget.targetCellWidth ?? 3}"
  android:targetCellHeight="${widget.targetCellHeight ?? 2}"
  android:updatePeriodMillis="0"
  android:initialLayout="@layout/glance_default_loading_layout"
  android:description="@string/${descriptionResourceName(widget)}"
  android:resizeMode="${resizeModeAttribute(widget)}"
  android:widgetCategory="home_screen" />
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function createWidgetStringsXml(widgets: WidgetAndroidWidget[]): string {
  const strings = widgets
    .map(
      (widget) =>
        `  <string name="${labelResourceName(widget)}">${escapeXml(widget.displayName)}</string>\n` +
        `  <string name="${descriptionResourceName(widget)}">${escapeXml(widget.description)}</string>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${strings}\n</resources>\n`;
}

export function createWidgetReceiver(widget: WidgetAndroidWidget): WidgetReceiver {
  return {
    $: {
      'android:name': `.widgets.${receiverClassName(widget)}`,
      'android:exported': 'true',
      'android:label': `@string/${labelResourceName(widget)}`
    },
    'intent-filter': [
      {
        action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }]
      }
    ],
    'meta-data': [
      {
        $: {
          'android:name': 'android.appwidget.provider',
          'android:resource': `@xml/${infoResourceName(widget)}`
        }
      },
      { $: { 'android:name': WIDGET_NAME_METADATA, 'android:value': widget.name } }
    ]
  };
}

function requireAndroidPackage(config: { android?: { package?: string } }): string {
  const androidPackage = config.android?.package;
  if (!androidPackage) {
    throw new Error(
      'react-native-widget-android requires `android.package` in app.json / app.config.js'
    );
  }
  return androidPackage;
}

const withWidgetFiles: ConfigPlugin<WidgetAndroidWidget[]> = (config, widgets) =>
  withDangerousMod(config, [
    'android',
    (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const platformRoot = cfg.modRequest.platformProjectRoot;
      const androidPackage = requireAndroidPackage(cfg);
      const mainPath = path.join(platformRoot, 'app/src/main');

      const kotlinSource = path.join(projectRoot, SOURCE_DIR, 'kotlin');
      const kotlinDestination = path.join(
        mainPath,
        'java',
        ...androidPackage.split('.'),
        'widgets'
      );
      fs.rmSync(kotlinDestination, { recursive: true, force: true });
      if (fs.existsSync(kotlinSource)) {
        fs.mkdirSync(kotlinDestination, { recursive: true });
        for (const file of fs.readdirSync(kotlinSource)) {
          if (!file.endsWith('.kt')) continue;
          const contents = fs
            .readFileSync(path.join(kotlinSource, file), 'utf8')
            .replaceAll(PLACEHOLDER_PACKAGE, androidPackage);
          fs.writeFileSync(path.join(kotlinDestination, file), contents);
        }
      }

      const resourceSource = path.join(projectRoot, SOURCE_DIR, 'res');
      const resourceDestination = path.join(mainPath, 'res');
      if (fs.existsSync(resourceSource)) {
        fs.cpSync(resourceSource, resourceDestination, { recursive: true });
      }

      const xmlDirectory = path.join(resourceDestination, 'xml');
      const valuesDirectory = path.join(resourceDestination, 'values');
      fs.mkdirSync(xmlDirectory, { recursive: true });
      fs.mkdirSync(valuesDirectory, { recursive: true });
      for (const widget of widgets) {
        fs.writeFileSync(
          path.join(xmlDirectory, `${infoResourceName(widget)}.xml`),
          createWidgetInfoXml(widget)
        );
      }
      fs.writeFileSync(path.join(valuesDirectory, STRINGS_FILE), createWidgetStringsXml(widgets));

      return cfg;
    }
  ]);

export function isWidgetReceiver(receiver: WidgetReceiver): boolean {
  return (
    receiver['meta-data']?.some(
      (metaData) => metaData.$['android:name'] === WIDGET_NAME_METADATA
    ) ?? false
  );
}

export function mergeWidgetReceivers(
  existing: WidgetReceiver[],
  widgets: WidgetAndroidWidget[]
): WidgetReceiver[] {
  return [
    ...existing.filter((receiver) => !isWidgetReceiver(receiver)),
    ...widgets.map(createWidgetReceiver)
  ];
}

const withWidgetReceivers: ConfigPlugin<WidgetAndroidWidget[]> = (config, widgets) =>
  withAndroidManifest(config, (cfg) => {
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    const receivers = (mainApplication.receiver ?? []) as WidgetReceiver[];
    mainApplication.receiver = mergeWidgetReceivers(receivers, widgets);
    return cfg;
  });

const COMPOSE_CLASSPATH = "classpath('org.jetbrains.kotlin:compose-compiler-gradle-plugin')";
const KOTLIN_CLASSPATH = "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')";

// A missed anchor means the expo template changed shape — fail at prebuild instead of letting
// gradle produce an unrelated Compose error later
function requireAnchor(contents: string, anchor: string, file: string): void {
  if (!contents.includes(anchor)) {
    throw new Error(
      `react-native-widget-android: could not find \`${anchor}\` in ${file} — the expo template changed; update the anchors in app.plugin.ts`
    );
  }
}

const withComposeClasspath: ConfigPlugin = (config) =>
  withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes(COMPOSE_CLASSPATH)) {
      return cfg;
    }
    requireAnchor(cfg.modResults.contents, KOTLIN_CLASSPATH, 'android/build.gradle');
    cfg.modResults.contents = cfg.modResults.contents.replace(
      KOTLIN_CLASSPATH,
      `${KOTLIN_CLASSPATH}\n    ${COMPOSE_CLASSPATH}`
    );
    return cfg;
  });

const KOTLIN_ANDROID_PLUGIN = 'apply plugin: "org.jetbrains.kotlin.android"';
const COMPOSE_PLUGIN = 'apply plugin: "org.jetbrains.kotlin.plugin.compose"';
const COMPOSE_BUILD_FEATURES = 'android {\n    buildFeatures {\n        compose true\n    }\n';

const withAppCompose: ConfigPlugin = (config) =>
  withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults.contents;
    if (!contents.includes(COMPOSE_PLUGIN)) {
      requireAnchor(contents, KOTLIN_ANDROID_PLUGIN, 'android/app/build.gradle');
      contents = contents.replace(
        KOTLIN_ANDROID_PLUGIN,
        `${KOTLIN_ANDROID_PLUGIN}\n${COMPOSE_PLUGIN}`
      );
    }
    if (!contents.includes('buildFeatures')) {
      requireAnchor(contents, 'android {\n', 'android/app/build.gradle');
      contents = contents.replace('android {\n', COMPOSE_BUILD_FEATURES);
    }
    cfg.modResults.contents = contents;
    return cfg;
  });

// Names become Kotlin class prefixes and manifest entries — anything else fails deep inside
// the Android build with no pointer back here
const WIDGET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

export function assertValidWidgetNames(widgets: WidgetAndroidWidget[]): void {
  for (const widget of widgets) {
    if (!WIDGET_NAME_PATTERN.test(widget.name)) {
      throw new Error(
        `react-native-widget-android: widget name '${widget.name}' must match ${WIDGET_NAME_PATTERN} (it becomes the ${widget.name}WidgetReceiver class name)`
      );
    }
  }
}

const withWidgetAndroid: ConfigPlugin<WidgetAndroidProps> = (config, props) => {
  const widgets = props?.widgets ?? [];
  if (widgets.length === 0) {
    return config;
  }
  assertValidWidgetNames(widgets);
  config = withWidgetFiles(config, widgets);
  config = withWidgetReceivers(config, widgets);
  config = withComposeClasspath(config);
  config = withAppCompose(config);
  return config;
};

export default createRunOncePlugin(withWidgetAndroid, 'react-native-widget-android', '0.0.1');
