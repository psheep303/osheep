# Contributing

English | [简体中文](CONTRIBUTING.md)

Osheep is evolving quickly. Open an issue before a large change to align on the use case, behavior,
and implementation direction.

## Development Setup

Install Node.js 20+, npm, and Git. Windows desktop development also requires Rust, Visual Studio C++
Build Tools, and WebView2.

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

Run `./dev.ps1` from the repository root for web development.

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
npm run test:workflow-behavior
```

For desktop changes, also run `cargo fmt --check`, `cargo clippy --locked -- -D warnings`, and
`cargo test --locked` from `desktop/src-tauri`.

Describe the motivation, observable behavior, verification, risks, migration steps, and relevant UI
screenshots in the pull request. By submitting a pull request, you agree to license your contribution
under the repository's MIT License. Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and report
security vulnerabilities through [SECURITY.en.md](SECURITY.en.md), not a public issue.
