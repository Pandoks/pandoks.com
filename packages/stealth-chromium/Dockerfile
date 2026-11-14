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
    APEX_CORE=patchright PORT=41000 HOST=0.0.0.0 \
    APEX_CHROME_PATH=/opt/stealth-chromium/chrome

# Runtime dependencies of the patched chrome binary + Xvfb (no system
# google-chrome -- the patched binary IS the browser).
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth x11-utils zstd curl jq ca-certificates \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
      libcairo2 libasound2 libatspi2.0-0 libx11-xcb1 libxcb-dri3-0 libxshmfence1 \
      libgtk-3-0 fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Persona-OS font layer (gaps doc 2.1 -- the strongest OS tell): a Linux
# container's font set under a Windows UA is a detector signal, so install the
# Windows 10/11 CORE font list (ground truth: /var/tmp/research/environment-
# coherence.md section 2.1, verified against Microsoft's Win10/11 font lists)
# and name-clone it onto the persona family names. All sources are free to
# redistribute:
#   ttf-mscorefonts-installer (contrib)  Microsoft's own Core Fonts for the Web
#                                        binaries (Arial, Times New Roman,
#                                        Courier New, Verdana, Trebuchet MS,
#                                        Georgia, Impact, Comic Sans MS, Andale
#                                        Mono, Webdings, Arial Black) under the
#                                        Microsoft Core Fonts EULA (freely
#                                        redistributable; the EXEs are fetched
#                                        from the SourceForge mscorefonts
#                                        mirror at build time)
#   fonts-crosextra-carlito/caladea      OFL 1.1 metric clones of Calibri/Cambria
#   Selawik (microsoft/Selawik 1.01)     OFL 1.1 -- Microsoft's official
#                                        open-licensed metric-compatible
#                                        Segoe UI design
#   fonts-wine                           LGPL 2.1 (Wine) -- Tahoma + Symbol +
#                                        Marlett carry their real Windows names
#   fonts-noto-cjk / -core / -color-emoji  OFL 1.1 (Noto) -- CJK + per-script
#                                        faces standing in for MS Gothic,
#                                        Malgun Gothic, SimSun, Yu Gothic and
#                                        the script fonts
#   fonts-croscore (Apache 2.0),         bases for the remaining names
#   fonts-dejavu-{core,extra}
# scripts/remap_persona_fonts.py then clones the faces under the Windows family
# names -- required because Skia's SkFontConfigInterfaceDirect::isAcceptableMatch
# only accepts a match whose real family name IS the requested one (see the
# header comment in chromium_src/third_party/blink/renderer/platform/fonts/
# apex_font_policy.h). Verification happens right in the layer: the build fails
# if any persona name fails to resolve.
COPY packages/stealth-chromium/scripts/remap_persona_fonts.py /tmp/remap_persona_fonts.py
COPY packages/stealth-chromium/scripts/verify_persona_fonts.sh /tmp/verify_persona_fonts.sh
RUN echo "deb http://deb.debian.org/debian bookworm main contrib" > /etc/apt/sources.list.d/contrib.list \
    && echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections \
    && apt-get update && apt-get install -y --no-install-recommends \
         fontconfig unzip ttf-mscorefonts-installer fonts-crosextra-carlito \
         fonts-crosextra-caladea fonts-wine fonts-noto-cjk fonts-noto-core \
         fonts-croscore fonts-dejavu-core fonts-dejavu-extra \
    && curl -fsSL -o /tmp/selawik.zip "https://github.com/microsoft/Selawik/releases/download/1.01/Selawik_Release.zip" \
    && unzip -q /tmp/selawik.zip -d /usr/local/share/fonts/selawik && rm /tmp/selawik.zip \
    && pip install --no-cache-dir fonttools \
    && python3 /tmp/remap_persona_fonts.py \
    && fc-cache -f \
    && sh /tmp/verify_persona_fonts.sh \
    && pip uninstall -y fonttools && rm -f /tmp/remap_persona_fonts.py /tmp/verify_persona_fonts.sh

WORKDIR /app

COPY packages/stealth-chromium/chromium/ /opt/stealth-chromium/
COPY packages/stealth-browser/ ./stealth-browser/
COPY packages/stealth-chromium/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /opt/stealth-chromium/chrome \
    && pip install --no-cache-dir ./stealth-browser

EXPOSE 41000
ENTRYPOINT ["/entrypoint.sh"]
