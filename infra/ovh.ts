export const OVH_CLOUD_PROJECT_SERVICE = process.env.OVH_CLOUD_PROJECT_SERVICE?.trim() ?? '';

export function requireOvhCloudProjectService(): string {
  if (!OVH_CLOUD_PROJECT_SERVICE) {
    throw new Error(
      'OVH_CLOUD_PROJECT_SERVICE is required for the cluster network and load balancers'
    );
  }
  return OVH_CLOUD_PROJECT_SERVICE;
}

export async function getFlavorId(region: string, flavorName: string): Promise<string> {
  const flavorsResult = await ovh.cloudproject.getFlavors({
    serviceName: requireOvhCloudProjectService(),
    region,
    nameFilter: flavorName
  });
  const flavor = flavorsResult.flavors.at(0);
  if (!flavor) {
    throw new Error(`Flavor ${flavorName} isn't available in ${region}`);
  }
  return flavor.id;
}

export async function getImageId(region: string, imageName: string): Promise<string> {
  const imagesResult = await ovh.cloudproject.getImages({
    serviceName: requireOvhCloudProjectService(),
    region,
    osType: 'linux'
  });
  const image = imagesResult.images.find((availableImage) => availableImage.name === imageName);
  if (!image) {
    throw new Error(`Image ${imageName} isn't available in ${region}`);
  }
  return image.id;
}

export async function getLoadBalancerFlavorId(region: string, flavorName: string): Promise<string> {
  const flavorsResult = await ovh.cloudproject.getLoadBalancerFlavors({
    serviceName: requireOvhCloudProjectService(),
    regionName: region
  });
  const flavor = flavorsResult.flavors.find(
    (availableFlavor) => availableFlavor.name === flavorName
  );
  if (!flavor) {
    throw new Error(`Load balancer flavor ${flavorName} isn't available in ${region}`);
  }
  return flavor.id;
}
