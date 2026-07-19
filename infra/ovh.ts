export function createOvhCloudProject(args: {
  stageName: string;
  protect: boolean;
}): ovh.cloudproject.Project {
  return new ovh.cloudproject.Project(
    'OvhPublicCloudProject',
    {
      deletionProtection: args.protect,
      description: `Pandoks ${args.stageName} Public Cloud project`,
      ovhSubsidiary: 'US',
      plan: {
        duration: 'P1M',
        planCode: 'project',
        pricingMode: 'default'
      }
    },
    { protect: args.protect }
  );
}

export function getFlavorId(
  serviceName: $util.Input<string>,
  region: string,
  flavorName: string
): $util.Output<string> {
  return ovh.cloudproject
    .getFlavorsOutput({
      serviceName,
      region,
      nameFilter: flavorName
    })
    .apply((flavorsResult) => {
      const flavor = flavorsResult.flavors.at(0);
      if (!flavor) {
        throw new Error(`Flavor ${flavorName} isn't available in ${region}`);
      }
      return flavor.id;
    });
}

export function getImageId(
  serviceName: $util.Input<string>,
  region: string,
  imageName: string
): $util.Output<string> {
  return ovh.cloudproject
    .getImagesOutput({
      serviceName,
      region,
      osType: 'linux'
    })
    .apply((imagesResult) => {
      const image = imagesResult.images.find((availableImage) => availableImage.name === imageName);
      if (!image) {
        throw new Error(`Image ${imageName} isn't available in ${region}`);
      }
      return image.id;
    });
}

export function getLoadBalancerFlavorId(
  serviceName: $util.Input<string>,
  region: string,
  flavorName: string
): $util.Output<string> {
  return ovh.cloudproject
    .getLoadBalancerFlavorsOutput({
      serviceName,
      regionName: region
    })
    .apply((flavorsResult) => {
      const flavor = flavorsResult.flavors.find(
        (availableFlavor) => availableFlavor.name === flavorName
      );
      if (!flavor) {
        throw new Error(`Load balancer flavor ${flavorName} isn't available in ${region}`);
      }
      return flavor.id;
    });
}
