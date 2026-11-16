#!/bin/sh
# Build one native executable with the complete browser application embedded.
set -eu
cd "$(dirname "$0")/.."
npm --prefix ui run build
rm -rf desktop/frontend
mkdir -p desktop/frontend
cp -r ui/static/out/. desktop/frontend/
CGO_ENABLED=0 go build -o desktop/build/driftmower-desktop ./desktop
