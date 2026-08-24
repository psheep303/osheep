# Contributing To Osheep

English | [简体中文](CONTRIBUTING.zh-CN.md)

Osheep keeps complex Agent / Harness workflows small, visual, and controllable. Contributions that
make the product simpler to use, broaden its reliable integration surface, or improve local-first
workflows are welcome.

For a large change, open an issue first with the user problem, expected behavior, and proposed
boundary. Small fixes, documentation improvements, and focused tests can go straight to a pull
request.

## Development Setup

Install Node.js 20+, npm, and Git. Linux web development also needs Python 3 and `build-essential`
to compile `node-pty`; Windows desktop development needs Rust, Visual Studio C++ Build Tools, and
WebView2.

```powershell
git clone https://github.com/psheep303/osheep.git
cd osheep

npm --prefix backend ci
npm --prefix frontend ci
npm --prefix desktop ci
```

Run `./dev.sh` on Linux or `.\dev.ps1` on Windows. See [README.md](README.md) for desktop commands.

## Pull Requests

- Keep a change focused; avoid unrelated formatting and generated files.
- Add tests for shared logic, API behavior, and regressions.
- Update affected English and Simplified Chinese user-facing documentation together.
- Never commit credentials, personal paths, sessions, logs, or workspace data.
- Explain the user-facing behavior and verification in the PR. Include screenshots for visual changes.
- Submit contributions under the repository's MIT License and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Run the checks relevant to your change before requesting review:

```bash
npm --prefix backend run lint
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend test
node scripts/check-public-repo.mjs
```

On Linux, `bash scripts/verify-linux.sh` reproduces the CI flow. For desktop changes, also run
`cargo fmt --check`, `cargo clippy --locked -- -D warnings`, and `cargo test --locked` from
`desktop/src-tauri`.

## Documentation

Keep tutorials short and task oriented. Put detailed behavior in a reference page, not in the first
run experience. English is canonical: use `README.md` for English and `.zh-CN.md` for Simplified
Chinese. Public docs belong in `docs/`; local notes and generated material belong in `.osheep/` and
must not be committed.

## Templates And The Marketspace

Use [osheep-template](https://github.com/psheep303/osheep-template) as the reference repository
for public template structure and examples. A publishable template needs `workflow.json` and
`README.md`; an icon is optional. Keep its chain short, make permissions and side effects obvious,
and test it in a clean workspace.

The [osheep-template-registry](https://github.com/psheep303/osheep-template-registry) is the
marketspace catalog. Add or update a registry entry there after the template repository is ready.
Users install registry entries locally, so template content must be reviewable and safe to inspect
before it runs.

## Build An Osheep Adapter

An **Osheep Adapter** connects one Agent or Harness to the common workflow runtime. It owns the
native CLI, HTTP, or SDK protocol and emits normalized sessions and events. The canvas should not
need a new special case for a new integration.

For a new adapter:

1. Define honest capabilities and a configuration schema.
2. Map native streaming events to Osheep lifecycle, assistant, tool, approval, and failure events.
3. Isolate process/HTTP/SDK control in a transport.
4. Add mapper edge-case tests and shared adapter contract tests.
5. Register the adapter explicitly in `backend/src/adapters/default-registry.ts`.
6. Document required installation, authentication, permissions, and unsupported behavior.

Read [docs/adapter-development.md](docs/adapter-development.md) before implementation. The current
repository does not execute third-party adapter packages merely because they appear in a workspace;
explicit registration is a deliberate trust boundary.

## Security

Do not report unpatched vulnerabilities in a public issue or pull request. Follow
[SECURITY.md](SECURITY.md) for private reporting.
