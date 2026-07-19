# OVH VPS-4 development host

SST provisions and lifecycle-manages the VPS-4 subscription declared in
`infra/dev.ts` for the `pandoks` stage. The code orders the VPS-4 plan using
12-month upfront pricing in `US-WEST-OR` with Ubuntu 26.04, standard daily
backup, local system storage, and no provider SSH key. It does not order
Premium backup, snapshots, or additional storage. The Pulumi resource is
protected against accidental replacement or deletion.

`setup.sh` configures and hardens the delivered host; it does not order,
reinstall, resize, or delete the VPS. There is intentionally no cloud-init or
automated guest bootstrap.

Because the non-production cluster currently has zero nodes, this VPS order
does not require an OVH Public Cloud project or k3s token. The OVH application
secret and consumer key are still required to authorize the VPS order.

## Provision the subscription

Review the billable order, then apply it:

```sh
pnpm sst diff --stage pandoks
pnpm sst deploy --stage pandoks
```

Do not approve the deployment unless the diff contains exactly one
`OvhDevVps` using the intended VPS-4 plan and location. Changing the plan,
location, or OS can replace or reinstall a manually configured host; review
those changes through an authenticated diff first.

## Initial console setup

Open the OVH KVM/web console. Do not enable or use public SSH.

```sh
apt-get update
apt-get install -y curl
install_script="$(mktemp)"
curl -fsSL https://tailscale.com/install.sh -o "${install_script}"
sh "${install_script}"
rm -f "${install_script}"
tailscale up \
  --ssh \
  --hostname=pandoks-dev-box \
  --accept-dns=false \
  --advertise-tags=tag:ovh,tag:dev
```

Open the printed Tailscale login URL and approve the device. Keep the OVH
console open.

## Prepare over Tailscale

From another terminal, prove that the private path works:

```sh
tailscale ssh root@pandoks-dev-box
```

Clone this repository using your normal GitHub authentication, then run:

```sh
cd pandoks.com
sudo scripts/dev-vps/setup.sh prepare
exit
tailscale ssh pandoks@pandoks-dev-box
cd pandoks.com
sudo scripts/dev-vps/setup.sh verify-tailscale
sudo scripts/dev-vps/setup.sh lockdown
sudo scripts/dev-vps/setup.sh status
pnpm bootstrap all
```

Do not close the original OVH console until the second
`tailscale ssh pandoks@pandoks-dev-box` succeeds after lockdown.

## Verify the public interface

From a machine outside the tailnet:

```sh
printf "VPS public IP from OVH Control Panel: "
read -r VPS_PUBLIC_IP
nc -vz -w 5 "${VPS_PUBLIC_IP}" 22
```

The connection must fail. Never save the entered address as an application
secret.

## Legacy SST state cleanup

Run this section only before the first `OvhDevVps` deployment and only if the
diff reports a historical `HetznerDevBox`, `OvhDevBox`, or registration-key
resource. Do not use it for the current `OvhDevVps`.

The checked-in helper is the only authorized cleanup procedure:

```sh
scripts/dev-vps/cleanup-state.sh
```

It privately exports state through the repository's local SST binary, accepts
exactly one historical family (Hetzner or OVH), rejects duplicates, mixed state,
and cross-provider types, and never prints an ID or registration key. It asks
for physical identifiers with terminal echo disabled, verifies them before any
state removal, makes the operator explicitly distinguish a retained manual
service from an already-deleted stale resource, handles only an exact key-only
orphan without a primary record after the operator types `orphan-remove`, and
rejects a final diff mentioning any of the four historical resource names. Do
not run ad-hoc `sst state remove` commands.

If registration-key detachment succeeds but primary detachment fails, the helper
reports partial completion, captures a private final diff when possible, and
exits. Do not apply that diff. Re-run the same helper: it will re-export state,
validate the remaining primary identity, and retry only that primary record.

## Recovery

If Tailscale fails before lockdown, continue in the still-open OVH console.

If access fails after lockdown, use the OVH KVM console or rescue environment:

```sh
nft flush ruleset
systemctl restart tailscaled
tailscale status
```

Repair Tailscale, prove `tailscale ssh pandoks@pandoks-dev-box`, then rerun:

```sh
cd pandoks.com
sudo scripts/dev-vps/setup.sh verify-tailscale
sudo scripts/dev-vps/setup.sh lockdown
```
