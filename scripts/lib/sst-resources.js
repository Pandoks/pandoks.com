import { Resource } from 'sst';

function main() {
  const resourceKeys = Object.keys(Resource);
  const flatResource = {};
  for (const key of resourceKeys) {
    const resource = Resource[key];
    const value = resource.value ?? resource.name ?? null;
    if (value != null) {
      flatResource[key] = value;
    }
  }

  console.log(JSON.stringify(flatResource));
}

main();
