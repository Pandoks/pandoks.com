import { createNodeBootstrap, deleteServerFromTailnet } from './bootstrap';
import type { ClusterNetwork } from '../network';
import type { ClusterNodeSpec, ClusterPlan, DedicatedNodePool } from '../topology';

export function createDedicatedNodes(args: {
  cluster: ClusterPlan;
  pool: DedicatedNodePool;
  nodes: readonly ClusterNodeSpec[];
  network: ClusterNetwork;
  apiAddress: $util.Input<string>;
  protect: boolean;
}) {
  const provisioned: Array<{ node: ClusterNodeSpec; publicIp: $util.Output<string> }> = [];
  for (const node of args.nodes) {
    const server = new ovh.dedicated.Server(
      node.logicalName,
      {
        displayName: node.hostname,
        ovhSubsidiary: args.network.foundation.subsidiary,
        preventInstallOnCreate: true,
        plans: [
          {
            duration: 'P1M',
            planCode: args.pool.planCode,
            pricingMode: 'default',
            quantity: 1,
            configurations: [
              { label: 'dedicated_datacenter', value: args.pool.datacenter },
              { label: 'dedicated_os', value: 'none_64.en' },
              { label: 'region', value: args.pool.orderRegion }
            ]
          }
        ],
        planOptions: args.pool.planOptions
      },
      {
        protect: args.protect,
        hooks: { afterDelete: [deleteServerFromTailnet] }
      }
    );
    const details = ovh.getServerOutput({ serviceName: server.serviceName });
    const vrackVni = details.vnis.apply((vnis) => {
      const vni = vnis.find((value) => value.enabled && value.mode === 'vrack');
      if (!vni?.nics[0]) {
        throw new Error(`Dedicated server ${node.hostname} has no enabled vRack NIC`);
      }
      return vni;
    });
    const attachment = new ovh.vrack.DedicatedServerInterface(
      `${node.logicalName}VrackInterface`,
      {
        serviceName: args.network.foundation.vrack.serviceName,
        interfaceId: vrackVni.apply((vni) => vni.uuid)
      },
      { dependsOn: [server, args.network.foundation.vrack] }
    );
    const bootstrap = createNodeBootstrap({
      cluster: args.cluster,
      node,
      apiAddress: args.apiAddress,
      networkCidr: args.network.subnet.cidr,
      networkMode: 'static',
      vrackMac: vrackVni.apply((vni) => vni.nics[0]),
      dependsOn: [server, attachment]
    });
    new ovh.dedicated.ServerReinstallTask(
      `${node.logicalName}Install`,
      {
        serviceName: server.serviceName,
        os: args.pool.operatingSystem,
        customizations: {
          hostname: node.hostname,
          postInstallationScript: bootstrap.apply((script) =>
            Buffer.from(script).toString('base64')
          ),
          postInstallationScriptExtension: 'sh'
        }
      },
      {
        dependsOn: [attachment],
        ignoreChanges: args.protect ? ['os', 'customizations', 'storages'] : [],
        protect: args.protect
      }
    );
    provisioned.push({ node, publicIp: server.ip });
  }

  return provisioned;
}
