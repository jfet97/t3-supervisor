#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if command -v direnv >/dev/null 2>&1; then
  direnv allow "$repo_root"
fi

# flakes may be disabled in the host configuration; enable them for this command only
exec nix --extra-experimental-features "nix-command flakes" develop "$repo_root" --command pnpm --dir "$repo_root" install --frozen-lockfile --prefer-offline --config.package-import-method=hardlink --config.confirmModulesPurge=false
