#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

if [[ $(uname -s) != Linux ]]; then
  printf '%s\n' 'This verification script must run on Linux.' >&2
  exit 1
fi

for command_name in bash git node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 20) { console.error("Node.js 20+ is required"); process.exit(1); }'
bash -n "$repo_root/dev.sh"

npm --prefix "$repo_root/backend" ci
npm --prefix "$repo_root/backend" run lint
npm --prefix "$repo_root/backend" run typecheck
npm --prefix "$repo_root/backend" test
npm --prefix "$repo_root/backend" run build

npm --prefix "$repo_root/frontend" ci
npm --prefix "$repo_root/frontend" run lint
npm --prefix "$repo_root/frontend" run typecheck
npm --prefix "$repo_root/frontend" test
npm --prefix "$repo_root/frontend" run build
