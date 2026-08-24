# Security Policy

[简体中文](SECURITY.md) · English

## Supported Versions

Osheep is in early development and does not maintain long-term support branches. Security fixes
land on the default branch and ship with the next release. Use the latest release or commit.

## Reporting a Vulnerability

Do not open a public issue for an unpatched vulnerability or include real API keys, tokens, private
keys, or personal data in a report.

Use **Report a vulnerability** on the repository Security page. If private vulnerability reporting
is unavailable, contact the maintainer privately through their GitHub profile and initially share
only enough information to establish a secure communication channel.

Include the affected version, minimal reproduction, actual impact, expected behavior, and known
mitigations. Wait for the maintainer to confirm a secure channel before sending exploit code.

## Deployment Boundary

The backend can modify workspace files, start terminal processes, run Git, and invoke local AI CLIs.
It is a privileged local tool, not a public sandbox.

- It listens on `127.0.0.1` by default and protects APIs and WebSockets with a random local session
  restricted to trusted Origins.
- Non-loopback listening requires `OSHEEP_AUTH_TOKEN` and explicit `CORS_ORIGIN` values.
- The shared token is only for controlled single-user deployments. Remote access also requires
  HTTPS, reverse-proxy access controls, and network isolation.
- Run the service as a dedicated low-privilege user and restrict accessible workspaces.
- Protect `~/.osheep`, `~/.codex`, `~/.claude`, and application data because they may contain
  plaintext credentials.
- Do not open or execute untrusted workspace content.

## Leaked Credentials

Immediately revoke leaked credentials, remove them from the current tree and Git history, force
update affected remote refs, notify collaborators, and scan every branch and tag again. Adding a
path to `.gitignore` or deleting only the current file does not invalidate an exposed credential.
