import { isProduction } from '../../dns';
import { createNodeBootstrap, deleteServerFromTailnet } from '../bootstrap';
import type { ClusterNetwork } from '../network';
import type { ClusterNodeSpec, DedicatedNodePool } from '../types';
import type { ClusterNode } from './public-cloud';

export function createDedicatedNode(args: {
  spec: ClusterNodeSpec & { pool: DedicatedNodePool };
  network: ClusterNetwork;
  apiAddress: $util.Input<string>;
}): ClusterNode {
  const server = new ovh.dedicated.Server(
    args.spec.logicalName,
    {
      displayName: args.spec.hostname,
      ovhSubsidiary: 'US',
      preventInstallOnCreate: true,
      plans: [
        {
          duration: 'P1M',
          planCode: args.spec.pool.plan,
          pricingMode: 'default',
          quantity: 1,
          configurations: [
            {
              label: 'dedicated_datacenter',
              value: args.spec.pool.datacenter
            },
            { label: 'dedicated_os', value: 'none_64.en' },
            { label: 'region', value: args.spec.pool.orderRegion }
          ]
        }
      ],
      planOptions: args.spec.pool.planOptions
    },
    {
      protect: isProduction,
      hooks: { afterDelete: [deleteServerFromTailnet] }
    }
  );

  const details = ovh.getServerOutput({ serviceName: server.serviceName });
  const vrackVni = details.vnis.apply((vnis) => {
    const value = vnis.find((vni) => vni.enabled && vni.mode === 'vrack');
    if (!value) {
      throw new Error(`Dedicated server ${args.spec.hostname} has no enabled vRack VNI`);
    }
    if (!value.nics[0]) {
      throw new Error(`Dedicated server ${args.spec.hostname} vRack VNI has no NIC`);
    }
    return value;
  });

  const attachment = new ovh.vrack.DedicatedServerInterface(
    `${args.spec.logicalName}VrackInterface`,
    {
      serviceName: args.network.vrack.serviceName,
      interfaceId: vrackVni.apply((vni) => vni.uuid)
    },
    { dependsOn: [server, args.network.vrack] }
  );

  const bootstrap = createNodeBootstrap({
    node: args.spec,
    apiAddress: args.apiAddress,
    networkCidr: args.network.cidr,
    networkMode: 'static',
    vrackMac: vrackVni.apply((vni) => vni.nics[0]),
    dependsOn: [server, attachment]
  });

  const install = new ovh.dedicated.ServerReinstallTask(
    `${args.spec.logicalName}Install`,
    {
      serviceName: server.serviceName,
      os: args.spec.pool.operatingSystem,
      customizations: {
        hostname: args.spec.hostname,
        postInstallationScript: bootstrap.dedicatedPostInstall,
        postInstallationScriptExtension: 'sh'
      }
    },
    {
      dependsOn: [attachment, bootstrap.tailnetKey],
      ignoreChanges: isProduction ? ['os', 'customizations', 'storages'] : [],
      protect: isProduction
    }
  );

  return {
    spec: args.spec,
    privateIp: $output(args.spec.privateIp),
    resource: server,
    readiness: install
  };
}
