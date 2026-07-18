# OVH VPS-4 development host

After the SST state cleanup in this runbook, SST does not purchase or manage
this VPS. Purchase or reinstall VPS-4 with Ubuntu 24.04 in the OVH Control
Panel.

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

## SST state cleanup

Export state before changing it:

```sh
./node_modules/.bin/sst state export --stage pandoks \
  > /tmp/pandoks-state-before-dev-vps-cleanup.json
jq -r '
  .deployment.resources[]
  | select(.urn | contains("OvhDevBox"))
  | [.urn, .type, (.protect // false)]
  | @tsv
' /tmp/pandoks-state-before-dev-vps-cleanup.json
```

This output intentionally does not print any registration-key value. Do not
print, copy, or put a registration-key value in shell history.

If there are no rows, no state cleanup is needed.

After confirming the `OvhDevBox` resource ID and keep/delete decision, if its
row identifies the VPS-4 that you are retaining manually, detach its state
record without deleting the physical service:

```sh
./node_modules/.bin/sst state remove OvhDevBox --stage pandoks
```

If its related `OvhDevBoxTailnetRegistrationAuthKey` row is present, confirm
that it belongs to this old dev-box configuration, then detach that state record
as well. Do not print or copy the key value:

```sh
./node_modules/.bin/sst state remove OvhDevBoxTailnetRegistrationAuthKey --stage pandoks
```

If the `OvhDevBox` row identifies an obsolete Public Cloud instance or failed
VPS order, confirm its service ID in the OVH Control Panel, delete that exact
provider resource there, and only then remove its stale state reference:

```sh
./node_modules/.bin/sst state remove OvhDevBox --stage pandoks
```

If a related `OvhDevBoxTailnetRegistrationAuthKey` row is present, confirm it
belongs to the obsolete configuration, then remove that stale state reference
without printing or copying its key value:

```sh
./node_modules/.bin/sst state remove OvhDevBoxTailnetRegistrationAuthKey --stage pandoks
```

Never run either `sst state remove` command until the resource IDs and the
keep/delete decision are confirmed.

Finally:

```sh
./node_modules/.bin/sst diff --stage pandoks
```

The diff must contain no creation, replacement, or deletion for either
`OvhDevBox` or `OvhDevBoxTailnetRegistrationAuthKey`.

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
