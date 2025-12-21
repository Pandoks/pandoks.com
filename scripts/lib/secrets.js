import { Resource } from 'sst';

function main() {
  const resourceKeys = Object.keys(Resource);
  const jsonResource = {};
  for (const key of resourceKeys) {
    const resource = Resource[key];
    jsonResource[key] = resource;
  }

  console.log(JSON.stringify(jsonResource));
}

main();
