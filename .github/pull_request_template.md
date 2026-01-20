# Title

## Description

## Checklist

- [ ] _If you have added a new dependency to this project_, make sure to add it to the dependencies
      part of the README.
- [ ] _If you have interacted with [`SST Secrets`](https://sst.dev/docs/component/secret/)_, make
      sure to deploy it and that it doesn't just exist in the intermediary state of `sst secret list`. Run
      `pnpm sst shell -- node ./scripts/lib/sst-resources.js` to see the deployed resources created
      by SST.
- [ ] _If you have created new templated compute variables_, make sure to add it to the
      `/scripts/cluster/deploy.sh` script's `cmd_deploy_compute_vars` function.
- [ ] _If you have created a new kubernetes node and control plane_, make sure to add the endpoint
      to the [`prom-grafana.yaml`](/k3s/overlays) overlays.
- [ ] _If you create a new app deployment_, make sure to add Prometheus metrics to export for
      observability.
