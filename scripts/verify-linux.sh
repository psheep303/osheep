#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

if [[ $(uname -s) != Linux ]]; then
  printf '%s\n' 'This verification script must run on Linux.' >&2
  exit 1
fi

for command_name in bash git cargo rustc node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

bash -n "$repo_root/dev.sh"

cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build -p osheep-server --release --locked

npm --prefix "$repo_root/frontend" ci
npm --prefix "$repo_root/frontend" run lint
npm --prefix "$repo_root/frontend" run typecheck
npm --prefix "$repo_root/frontend" test
npm --prefix "$repo_root/frontend" run build
