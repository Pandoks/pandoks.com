#!/bin/sh
set -eu
# headful Chrome under a virtual display -- the display is real to the page;
# only the windowing is virtual. The server picks the patched binary via
# APEX_CHROME_PATH (set in the Dockerfile); without it it falls back to the
# system Chrome. Port range matches the Dockerfile EXPOSE.
exec xvfb-run -a --server-args="-screen 0 1920x1080x24" \
    python -m stealth_browser.server
