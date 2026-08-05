#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
start_backend=1
start_frontend=1
install_dependencies=0
developer_mode=0

usage() {
  printf '%s\n' "Usage: bash ./dev.sh [--backend-only|--frontend-only] [--install] [--developer]"
}

for argument in "$@"; do
  case "$argument" in
    --backend-only) start_frontend=0 ;;
    --frontend-only) start_backend=0 ;;
    --install) install_dependencies=1 ;;
    --developer) developer_mode=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$argument" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for command_name in node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

install_project() {
  local project_dir=$1
  if (( install_dependencies )) || [[ ! -d "$project_dir/node_modules" ]]; then
    printf '[install] %s\n' "${project_dir#"$repo_root/"}"
    npm --prefix "$project_dir" ci
  fi
}

pids=()
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if ((${#pids[@]})); then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

if (( start_backend )); then
  install_project "$repo_root/backend"
  printf '[backend] http://127.0.0.1:%s\n' "${OSHEEP_PORT:-4178}"
  (
    cd "$repo_root/backend"
    if (( developer_mode )); then export OSHEEP_DEVELOPER_MODE=1; fi
    exec npm run dev
  ) &
  pids+=("$!")
fi

if (( start_frontend )); then
  install_project "$repo_root/frontend"
  printf '%s\n' '[frontend] http://127.0.0.1:5173'
  (
    cd "$repo_root/frontend"
    exec npm run dev
  ) &
  pids+=("$!")
fi

if ((${#pids[@]} == 0)); then
  printf '%s\n' 'Nothing to start.' >&2
  exit 2
fi

set +e
wait -n "${pids[@]}"
status=$?
set -e
exit "$status"
