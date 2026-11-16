#!/bin/sh
# Rebuilds the desktop dashboard and runs it, replacing a running copy.
set -eu
cd "$(dirname "$0")/.."
desktop/build.sh
exec desktop/build/driftmower-desktop --restart
