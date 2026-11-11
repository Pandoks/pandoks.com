FROM amazonlinux:2023@sha256:3ccfbe800f864982b0a4e124a614b2382518cbd04b3c1cd35202bd46f392675b

# renovate: datasource=github-releases depName=aws/aws-emulator extractVersion=^v(?<version>.+)$
ARG AWS_EMULATOR_VERSION=1.0.322

# NOTE: AWS publishes no checksums, so dnf checks the package's signature against AWS's key
# (fingerprint 98BC F336 A3BE 53B7 34E9 67C5 2E5B F49B D940 F624)
COPY aws-publishing.asc /tmp/aws-publishing.asc
RUN rpm --import /tmp/aws-publishing.asc \
  && dnf install -y --setopt=localpkg_gpgcheck=1 \
  "https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/aws-emulator-${AWS_EMULATOR_VERSION}-1-$(uname -m).rpm" \
  && dnf clean all \
  && rm /tmp/aws-publishing.asc

USER 1000
ENV HOME=/tmp
EXPOSE 9297
# NOTE: auth off because the emulator regenerates its keys every start; k3d pods sign with any key
ENTRYPOINT ["aws-emulator", "--bind", "0.0.0.0", "--auth", "off", "--telemetry", "off"]
