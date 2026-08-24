# Public Repository Checklist

Complete this checklist before changing the GitHub repository visibility to public.

## Repository Content

- Merge the intended release branch into `main` through a reviewed pull request.
- Run `node scripts/check-public-repo.mjs --history` from a clone with every remote branch fetched.
- Run Gitleaks or an equivalent dedicated scanner against all branches and tags. Review every
  entry in `.gitleaksignore` against the referenced revision before accepting the result.
- Review every remote branch, tag, issue, pull request, Actions log, release, and wiki page.
- Confirm that commit author names and email addresses are safe to publish.
- Remove internal reports from reachable history when deletion from the current tree is insufficient.

## GitHub Settings

- Protect `main` and require the backend, frontend, desktop, and repository-hygiene CI jobs.
- Enable private vulnerability reporting, dependency graph, Dependabot alerts, secret scanning, and push protection.
- Confirm that Actions workflow permissions default to read-only.
- Disable force pushes and branch deletion on `main`.

## Release Readiness

- Verify the quick start from a clean Windows environment.
- Publish only artifacts built from a clean version tag.
- Attach SHA-256 checksums, third-party license notices, and an SBOM to release artifacts.
- Sign Windows installers before recommending them to general users.
- Recheck the repository from a signed-out browser after the visibility change.
