export function renderCloudInit(
  config: string,
  environment: Readonly<Record<string, string | undefined>>
): string {
  return config.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => environment[name] ?? '');
}
