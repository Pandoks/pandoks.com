import { Resource } from 'sst';

function main(): void {
  // `Resource` is declared as an interface of known keys with heterogeneous
  // shapes (some entries expose `value`, some `name`). Narrowing it to an
  // iterable record is the one spot that needs a deliberate type decision.
  //
  // TODO(you): replace `resources` with a typed view of `Resource` so that
  //   `Object.entries` yields entries whose `.value` / `.name` are reachable.
  //   Consider: a single `as` cast vs. a typed helper; how strict to be about
  //   the `string | undefined` values; whether to assert keys are present.
  const resources = Resource as Record<string, Record<string, string | undefined>>;

  const flatResource: Record<string, string> = {};
  for (const [key, resource] of Object.entries(resources)) {
    const value = resource.value ?? resource.name ?? null;
    if (value != null) {
      flatResource[key] = value;
    }
  }

  console.log(JSON.stringify(flatResource));
}

main();
