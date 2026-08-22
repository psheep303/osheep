# Osheep Documentation

This directory contains documentation intended to ship with the public repository. Documents here
must describe current behavior, avoid private environment details, and remain useful to users,
contributors, or maintainers.

## Guides

- [Workflow blocks](workflow-blocks.md): available workflow blocks, configuration, and behavior.
- [Workflow block output contract](workflow-block-output.md): structured outputs shared between
  workflow blocks.
- [Adapter development](adapter-development.md): how to connect an agent or harness to OSheep.
- [Public repository checklist](public-release-checklist.md): security and release checks required
  before publishing the repository.

## Documentation Boundary

- Put public user, contributor, architecture, security, and maintenance documentation in `docs/`.
- Put implementation notes, investigations, temporary plans, generated reports, and development
  prompts in `.osheep/docs/`. The complete `.osheep/` directory is local state and is ignored by
  Git.
- Keep runtime-generated workflow and editor state under `.osheep/`; do not move it into `docs/`.

Before moving a development document here, verify it against the current implementation, remove
local paths and credentials, and update links from the repository README when appropriate.
