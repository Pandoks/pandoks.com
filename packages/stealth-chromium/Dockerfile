# stealth-browser runtime image, carrying the PATCHED Chromium binary.
#
# Build flow: the cloud runner (dev-runner SFN) compiles the patched binary
# and uploads chromium-<version>.tar.zst to the artifacts bucket. Fetch that,
# extract it into this build context as `chromium/`, then:
#
#   aws s3 cp "s3://<artifacts>/<build-id>/chromium-157.0.8103.27.tar.zst" .
#   tar --use-compress-program 'zstd -d --long=27' -xf chromium-*.tar.zst -C .
#   docker build -f packages/stealth-chromium/Dockerfile .      (context: repo root)
#
# The binary is Linux x86_64, so run the image with --platform linux/amd64
# (Rosetta on Apple Silicon; slow to boot but fully functional). Use a
# .dockerignore (node_modules) or the context will be huge.
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 DEBIAN_FRONTEND=noninteractive \
    APEX_CORE=patchright PORT=8089 HOST=0.0.0.0 \
    APEX_CHROME_PATH=/opt/stealth-chromium/chrome

# Runtime dependencies of the patched chrome binary + Xvfb (no system
# google-chrome -- the patched binary IS the browser).
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb zstd curl jq ca-certificates \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
      libcairo2 libasound2 libatspi2.0-0 libx11-xcb1 libxcb-dri3-0 libxshmfence1 \
      libgtk-3-0 fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY packages/stealth-chromium/chromium/ /opt/stealth-chromium/
COPY packages/stealth-browser/ ./stealth-browser/
COPY packages/stealth-chromium/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /opt/stealth-chromium/chrome \
    && pip install --no-cache-dir ./stealth-browser

EXPOSE 41000
ENTRYPOINT ["/entrypoint.sh"]
