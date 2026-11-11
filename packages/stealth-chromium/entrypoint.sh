#!/bin/sh
set -eu
# headful Chrome under a virtual display -- the display is real to the page;
# only the windowing is virtual. The server picks the patched binary via
# APEX_CHROME_PATH (set in the Dockerfile); without it it falls back to the
# system Chrome. Port range matches the Dockerfile EXPOSE.
#
# WARNING: do not go back to `xvfb-run -a` here. Its -displayfd readiness
# handoff is flaky in this image (X reports the server as up but the write
# to the handoff fd is never observed, so xvfb-run waits forever and the
# container produces zero output -- reproduced on EC2 3 out of 4 runs and
# under Apple Silicon emulation). Start Xvfb explicitly and gate on the
# unix socket instead.
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
for _ in $(seq 1 60); do
    [ -e /tmp/.X11-unix/X99 ] && break
    sleep 0.5
done
export DISPLAY=:99
exec python -m stealth_browser.server
