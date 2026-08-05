# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Osheep is evolving quickly. Open an issue before a large change to align on the use case, behavior,
and implementation direction.

## Development Setup

Install Node.js 20+, npm, and Git. Linux web development also needs Python 3 and `build-essential`
to compile `node-pty`. Windows desktop development requires Rust, Visual Studio C++ Build Tools,
and WebView2.

```powershell
git clone https://github.com/psheep303/osheep.git
cd osheep

cd backend
npm ci
cd ..\frontend
npm ci
cd ..\desktop
npm ci
```

Run `bash ./dev.sh` on Linux or `.\dev.ps1` on Windows from the repository root for web development.

## Documentation Language

English is the canonical and default language for public project documentation. Use the
unsuffixed name for English files, such as `README.md`, and use `.zh-CN.md` for Simplified Chinese,
such as `README.zh-CN.md`. Keep both versions aligned when changing user-visible documentation.

## Before a Pull Request

- Keep the change focused and avoid unrelated formatting or generated files.
- Add tests for shared logic, API behavior, and bug fixes.
- Update affected documentation and configuration examples.
- Do not commit credentials, personal paths, sessions, logs, or workspace data.
- Run `node scripts/check-public-repo.mjs`.

Backend verification:

```powershell
cd backend
npm run lint
npm run build
npm test
```

Frontend verification:

```powershell
cd frontend
npm run lint
npm run build
npm test
```

On Linux, `bash scripts/verify-linux.sh` reproduces the complete CI flow from dependency installation.

For desktop changes, also run `cargo fmt --check`, `cargo clippy --locked -- -D warnings`, and
`cargo test --locked` from `desktop/src-tauri`.

Describe the motivation, observable behavior, verification, risks, migration steps, and relevant UI
screenshots in the pull request. By submitting a pull request, you agree to license your contribution
under the repository's MIT License. Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and report
security vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.
