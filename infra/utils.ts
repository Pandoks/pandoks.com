export const isProduction = $app.stage === 'production';

export const domain = isProduction ? 'pandoks.com' : 'dev.pandoks.com';

export const EXAMPLE_DOMAIN = 'example.pandoks.com';

export const STAGE_NAME = isProduction ? 'prod' : 'dev';

export function renderCloudInit(
  config: string,
  environment: Readonly<Record<string, string | undefined>>
): string {
  return config.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => environment[name] ?? '');
}
