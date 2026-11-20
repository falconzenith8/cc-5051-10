#!/usr/bin/env bash
# Launch a headless Chromium from the locally extracted sysroot (no root required).
# Usage: tools/chrome.sh <script.mjs>   where script imports { chromium } from 'playwright'
set -euo pipefail
PW_ROOT=${PW_ROOT:-/tmp/pw}
SYSROOT=${SYSROOT:-$PW_ROOT/sysroot}
export LD_LIBRARY_PATH="$SYSROOT/usr/lib/aarch64-linux-gnu:$SYSROOT/lib/aarch64-linux-gnu:$SYSROOT/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export NODE_PATH="$PW_ROOT/node_modules${NODE_PATH:+:$NODE_PATH}"
exec node "$@"
