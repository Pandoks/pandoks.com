# OVH VPS-4 development host

SST does not purchase or manage this VPS. Purchase or reinstall VPS-4 with
Ubuntu 24.04 in the OVH Control Panel.

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
  | [.urn, .type, (.id // ""), (.protect // false)]
  | @tsv
' /tmp/pandoks-state-before-dev-vps-cleanup.json
```

If there is no row, no state cleanup is needed.

If the row identifies the VPS-4 that you are retaining manually, detach it
without deleting the physical service:

```sh
./node_modules/.bin/sst state remove OvhDevBox --stage pandoks
```

If the row identifies an obsolete Public Cloud instance or failed VPS order,
confirm its service ID in the OVH Control Panel, delete that exact provider
resource there, and only then remove the stale state reference:

```sh
./node_modules/.bin/sst state remove OvhDevBox --stage pandoks
```

Never run `sst state remove OvhDevBox` until the resource ID and the keep/delete
decision are confirmed.

Finally:

```sh
./node_modules/.bin/sst diff --stage pandoks
```

The diff must contain no dev-box creation, replacement, or deletion.

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
