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
  | select(
      (.urn | endswith("::HetznerDevBox"))
      or (.urn | endswith("::HetznerDevBoxTailnetRegistrationAuthKey"))
      or (.urn | endswith("::OvhDevBox"))
      or (.urn | endswith("::OvhDevBoxTailnetRegistrationAuthKey"))
    )
  | [.urn, .type, (.protect // false)]
  | @tsv
' /tmp/pandoks-state-before-dev-vps-cleanup.json
```

This output intentionally does not print any registration-key value. Do not
print, copy, or put a registration-key value in shell history.

Two exact state identity families may exist: the merge-base Hetzner resources
(`HetznerDevBox`, `HetznerDevBoxTailnetRegistrationAuthKey`) or the intermediate
OVH resources (`OvhDevBox`, `OvhDevBoxTailnetRegistrationAuthKey`). The
following decision tree selects at most one family without printing a physical
ID or key value. If both HetznerDevBox and OvhDevBox families are represented,
or if any exact logical name is duplicated, do not continue.

```sh
HETZNER_DEV_BOX_COUNT="$(jq '
  [.deployment.resources[] | select(.urn | endswith("::HetznerDevBox"))] | length
' /tmp/pandoks-state-before-dev-vps-cleanup.json)"
HETZNER_DEV_BOX_KEY_COUNT="$(jq '
  [.deployment.resources[]
   | select(.urn | endswith("::HetznerDevBoxTailnetRegistrationAuthKey"))]
  | length
' /tmp/pandoks-state-before-dev-vps-cleanup.json)"
OVH_DEV_BOX_COUNT="$(jq '
  [.deployment.resources[] | select(.urn | endswith("::OvhDevBox"))] | length
' /tmp/pandoks-state-before-dev-vps-cleanup.json)"
OVH_DEV_BOX_KEY_COUNT="$(jq '
  [.deployment.resources[]
   | select(.urn | endswith("::OvhDevBoxTailnetRegistrationAuthKey"))]
  | length
' /tmp/pandoks-state-before-dev-vps-cleanup.json)"

case "${HETZNER_DEV_BOX_COUNT}:${HETZNER_DEV_BOX_KEY_COUNT}:${OVH_DEV_BOX_COUNT}:${OVH_DEV_BOX_KEY_COUNT}" in
  "0:0:0:0")
    DEV_BOX_COUNT=0
    DEV_BOX_KEY_COUNT=0
    DEV_BOX_LOGICAL_NAME=
    DEV_BOX_KEY_LOGICAL_NAME=
    DEV_BOX_FAMILY=
    printf '%s\n' "No historical dev-box state record is present; continue to the final diff."
    ;;
  "0:1:0:0" | "1:0:0:0" | "1:1:0:0")
    DEV_BOX_COUNT="${HETZNER_DEV_BOX_COUNT}"
    DEV_BOX_KEY_COUNT="${HETZNER_DEV_BOX_KEY_COUNT}"
    DEV_BOX_LOGICAL_NAME=HetznerDevBox
    DEV_BOX_KEY_LOGICAL_NAME=HetznerDevBoxTailnetRegistrationAuthKey
    DEV_BOX_FAMILY=hetzner
    ;;
  "0:0:0:1" | "0:0:1:0" | "0:0:1:1")
    DEV_BOX_COUNT="${OVH_DEV_BOX_COUNT}"
    DEV_BOX_KEY_COUNT="${OVH_DEV_BOX_KEY_COUNT}"
    DEV_BOX_LOGICAL_NAME=OvhDevBox
    DEV_BOX_KEY_LOGICAL_NAME=OvhDevBoxTailnetRegistrationAuthKey
    DEV_BOX_FAMILY=ovh
    ;;
  *)
    printf '%s\n' "Historical dev-box state records are mixed or ambiguous; do not continue."
    unset HETZNER_DEV_BOX_COUNT HETZNER_DEV_BOX_KEY_COUNT
    unset OVH_DEV_BOX_COUNT OVH_DEV_BOX_KEY_COUNT
    exit 1
    ;;
esac
unset HETZNER_DEV_BOX_COUNT HETZNER_DEV_BOX_KEY_COUNT
unset OVH_DEV_BOX_COUNT OVH_DEV_BOX_KEY_COUNT

if [ "${DEV_BOX_COUNT}" -eq 0 ] && [ "${DEV_BOX_KEY_COUNT}" -eq 1 ]; then
  printf '%s\n' "Only one exact registration-key state record is present; removing that orphaned record."
  if ./node_modules/.bin/sst state remove "${DEV_BOX_KEY_LOGICAL_NAME}" --stage pandoks; then
    DEV_BOX_KEY_COUNT=0
    printf '%s\n' "The orphaned registration-key state record was removed."
  else
    printf '%s\n' "The orphaned registration-key state record could not be removed; do not continue."
    exit 1
  fi
fi
```

If `DEV_BOX_COUNT` is zero, do not run either primary detach/delete branch
below. If it is one, run this type-aware identity gate first. It verifies the
selected family's provider type and physical ID. For an OVH Public Cloud
instance it also verifies `inputs.serviceName`. The gate prints no ID or service
value and removes entered values from the shell after comparison.

For `HetznerDevBox`, the only accepted type is
`hcloud:index/server:Server`; obtain that server's numeric ID from the Hetzner
Control Panel. For `OvhDevBox`, the accepted types remain
`ovh:CloudProject/instance:Instance` and
`ovh:Vps/vps:Vps`; obtain the corresponding IDs from the OVH Control Panel. Any
cross-family provider type, unsupported type, or mismatch stops the procedure.

```sh
DEV_BOX_IDENTITY_VERIFIED=false
if [ "${DEV_BOX_COUNT}" -eq 1 ]; then
DEV_BOX_TYPE="$(jq -r --arg logical "${DEV_BOX_LOGICAL_NAME}" '
  [.deployment.resources[] | select(.urn | endswith("::" + $logical))]
  | if length == 1 then .[0].type else empty end
' /tmp/pandoks-state-before-dev-vps-cleanup.json)"

case "${DEV_BOX_FAMILY}:${DEV_BOX_TYPE}" in
  "hetzner:hcloud:index/server:Server")
    printf "Expected Hetzner server ID from Control Panel: "
    read -r EXPECTED_SERVER_ID
    if jq -e \
      --arg logical "${DEV_BOX_LOGICAL_NAME}" \
      --arg expected "${EXPECTED_SERVER_ID}" '
        any(
          .deployment.resources[];
          (.urn | endswith("::" + $logical))
          and (.type == "hcloud:index/server:Server")
          and (.id == $expected)
        )
      ' /tmp/pandoks-state-before-dev-vps-cleanup.json > /dev/null; then
      DEV_BOX_IDENTITY_VERIFIED=true
      printf '%s\n' "HetznerDevBox physical server ID matches exported state."
    else
      printf '%s\n' "HetznerDevBox physical server ID does not match exported state; do not continue."
      unset EXPECTED_SERVER_ID DEV_BOX_TYPE
      exit 1
    fi
    unset EXPECTED_SERVER_ID
    ;;
  "ovh:ovh:CloudProject/instance:Instance")
    printf "Expected OVH Public Cloud instance ID/UUID from Control Panel: "
    read -r EXPECTED_INSTANCE_ID
    printf "Expected OVH Public Cloud project/service ID from Control Panel: "
    read -r EXPECTED_PROJECT_SERVICE_ID
    if jq -e \
      --arg logical "${DEV_BOX_LOGICAL_NAME}" \
      --arg instance "${EXPECTED_INSTANCE_ID}" \
      --arg project "${EXPECTED_PROJECT_SERVICE_ID}" '
        any(
          .deployment.resources[];
          (.urn | endswith("::" + $logical))
          and (.type == "ovh:CloudProject/instance:Instance")
          and (.id == $instance)
          and (.inputs.serviceName == $project)
        )
      ' /tmp/pandoks-state-before-dev-vps-cleanup.json > /dev/null; then
      DEV_BOX_IDENTITY_VERIFIED=true
      printf '%s\n' "OvhDevBox instance and project/service IDs match exported state."
    else
      printf '%s\n' "OvhDevBox instance or project/service ID does not match exported state; do not continue."
      unset EXPECTED_INSTANCE_ID EXPECTED_PROJECT_SERVICE_ID DEV_BOX_TYPE
      exit 1
    fi
    unset EXPECTED_INSTANCE_ID EXPECTED_PROJECT_SERVICE_ID
    ;;
  "ovh:ovh:Vps/vps:Vps")
    printf "Expected OVH VPS service name/ID from Control Panel: "
    read -r EXPECTED_VPS_SERVICE_ID
    if jq -e \
      --arg logical "${DEV_BOX_LOGICAL_NAME}" \
      --arg expected "${EXPECTED_VPS_SERVICE_ID}" '
        any(
          .deployment.resources[];
          (.urn | endswith("::" + $logical))
          and (.type == "ovh:Vps/vps:Vps")
          and (.id == $expected)
        )
      ' /tmp/pandoks-state-before-dev-vps-cleanup.json > /dev/null; then
      DEV_BOX_IDENTITY_VERIFIED=true
      printf '%s\n' "OvhDevBox VPS service name/ID matches exported state."
    else
      printf '%s\n' "OvhDevBox VPS service name/ID does not match exported state; do not continue."
      unset EXPECTED_VPS_SERVICE_ID DEV_BOX_TYPE
      exit 1
    fi
    unset EXPECTED_VPS_SERVICE_ID
    ;;
  *)
    printf '%s\n' "Selected dev-box provider type is unsupported, cross-family, or ambiguous; do not continue."
    unset DEV_BOX_TYPE
    exit 1
    ;;
esac
unset DEV_BOX_TYPE
fi
[ "${DEV_BOX_COUNT}" -eq 0 ] || [ "${DEV_BOX_IDENTITY_VERIFIED}" = true ]
```

If the gate does not report a match, do not run either detach/delete branch.

Only after the identity gate reports a match and the keep/delete decision is
confirmed, if the selected row identifies the server that you are retaining
manually, detach its state record without deleting the physical service:

```sh
[ "${DEV_BOX_IDENTITY_VERIFIED}" = true ]
./node_modules/.bin/sst state remove "${DEV_BOX_LOGICAL_NAME}" --stage pandoks
```

Only if `DEV_BOX_KEY_COUNT` is one, confirm that the selected family's
registration-key row belongs to this old dev-box configuration, then detach
that state record as well. Do not print or copy the key value:

```sh
[ "${DEV_BOX_IDENTITY_VERIFIED}" = true ]
[ "${DEV_BOX_KEY_COUNT}" -eq 1 ]
./node_modules/.bin/sst state remove "${DEV_BOX_KEY_LOGICAL_NAME}" --stage pandoks
```

Alternatively, only after the same identity gate reports a match, if the
selected row identifies an obsolete Hetzner server, OVH Public Cloud instance,
or failed OVH VPS order, delete that exact physical provider resource in its
Control Panel and only then remove its stale state reference:

```sh
[ "${DEV_BOX_IDENTITY_VERIFIED}" = true ]
./node_modules/.bin/sst state remove "${DEV_BOX_LOGICAL_NAME}" --stage pandoks
```

Only if `DEV_BOX_KEY_COUNT` is one, confirm that the selected family's key row
belongs to that obsolete configuration, then remove the stale key reference:

```sh
[ "${DEV_BOX_IDENTITY_VERIFIED}" = true ]
[ "${DEV_BOX_KEY_COUNT}" -eq 1 ]
./node_modules/.bin/sst state remove "${DEV_BOX_KEY_LOGICAL_NAME}" --stage pandoks
```

Never remove a primary state record until the selected family's identity gate
reports a match and the keep/delete decision is confirmed. Remove a key record
only with its one confirmed primary family or as the exact key-only orphan
handled by the decision tree. Clear the shell variables when finished:

```sh
unset DEV_BOX_COUNT DEV_BOX_KEY_COUNT DEV_BOX_LOGICAL_NAME
unset DEV_BOX_KEY_LOGICAL_NAME DEV_BOX_FAMILY DEV_BOX_IDENTITY_VERIFIED
```

Finally:

```sh
./node_modules/.bin/sst diff --stage pandoks
```

The diff must contain no creation, replacement, or deletion for
`HetznerDevBox`, `HetznerDevBoxTailnetRegistrationAuthKey`, `OvhDevBox`, or
`OvhDevBoxTailnetRegistrationAuthKey`.

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
