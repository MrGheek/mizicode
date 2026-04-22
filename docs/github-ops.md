# GitHub Operations Runbook

This document describes the manual GitHub settings that must be applied after the workflow files in `.github/workflows/` are merged. The workflows enforce CI correctness; the settings below enforce branch protection and code-review policy.

> **Important**: Merge queue, required status checks, CODEOWNERS review enforcement, and dismiss-stale-approvals are **GitHub repository/ruleset settings — they are not enforced by workflow files alone**. Workflow files only define what runs; they cannot block merges without the branch protection rules below.

---

## Recommended rollout order

1. Merge the `.github/` configuration PR (labels, workflows, CODEOWNERS, templates).
2. Trigger the `Sync Labels` workflow manually (`workflow_dispatch`) to populate labels on the repo.
3. Apply branch protection rules (see section below).
4. Enable merge queue (see section below).
5. Soak for 1–2 weeks before making CodeQL a required check (CodeQL is added in Layer 2 / Task #133).

---

## Branch protection — `main`

Set these under **Settings → Branches → Branch protection rules** (or Rulesets if using the new ruleset UI).

| Setting | Value | Notes |
|---|---|---|
| Require a pull request before merging | ✅ enabled | No direct pushes to `main` |
| Required approvals | `1` minimum | Increase to `2` for higher-risk changes |
| Dismiss stale pull request approvals when new commits are pushed | ✅ enabled | Prevents stale approvals after force-push |
| Require review from Code Owners | ✅ enabled | Uses `.github/CODEOWNERS` |
| Require status checks to pass before merging | ✅ enabled | See required checks below |
| Require branches to be up to date before merging | ✅ enabled | Ensures CI runs on merged state |
| Require conversation resolution before merging | ✅ enabled | Optional but recommended |
| Restrict who can push to matching branches | Configure as appropriate | |

---

## Required status checks

Add the following check names exactly as they appear in the workflow `name:` fields. GitHub matches on the exact string.

| Check name | Source workflow | When required |
|---|---|---|
| `TypeScript type-check` | `ci.yml` (job: `typecheck`) | Required from day 1 |
| `Build API server` | `ci.yml` (job: `build-api`) | Optional — runs only when api/shared files change |
| `Build dashboard` | `ci.yml` (job: `build-dashboard`) | Optional — runs only when dashboard/shared files change |
| `Validate PR title (conventional commits)` | `commitlint.yml` | Required from day 1 |
| `Lint workflow files with actionlint` | `workflow-hygiene.yml` | Required from day 1 |
| `Apply component labels` | `pr-labeler.yml` | Optional — informational only |

> **Important — required check strategy**: `ci-all.yml` intentionally does **not** use `paths-ignore`. Required status checks must run on every PR (including docs-only PRs) or GitHub branch protection will block the merge when the required check never fires. The path-filter matrix inside `ci.yml` handles build job skipping efficiently — the `TypeScript type-check` job always runs quickly, so docs-only PRs complete CI in ~1 minute without running expensive build steps.
>
> Do **not** add `paths-ignore` to `ci-all.yml` or any workflow whose jobs are marked as required checks. Only add `paths-ignore` to purely informational workflows.

> **Note on CodeQL**: CodeQL checks (added in Task #133) should be added as *informational* checks initially and only made **required** after a soak period to verify there are no false-positive failures that would block legitimate PRs.

---

## Merge queue

Merge queue serializes merges against `main`, running CI on the merged result before the commit lands. This eliminates the "works on my branch" race condition.

Enable under **Settings → General → Pull Requests → Merge queue** (available on GitHub Team and Enterprise).

Recommended merge queue settings:

- **Merge method**: Squash (aligns with commitlint's PR-title-as-commit-message approach)
- **Minimum group size**: 1
- **Maximum group size**: 5
- **Wait time**: 5 minutes (allows grouping of simultaneous PRs)
- **Required checks**: same list as branch protection above

> **Important**: Once merge queue is enabled, update the required checks to use the merge queue check names, not just the PR check names. GitHub exposes these as separate entries.

---

## CODEOWNERS review enforcement

CODEOWNERS defines which teams own which paths. GitHub enforces this at merge time when "Require review from Code Owners" is enabled in branch protection.

Current owner mapping (see `.github/CODEOWNERS` for canonical source):

| Path | Owner team |
|---|---|
| `*` (default) | `@gheeklabs/core` |
| `artifacts/api-server/**` | `@gheeklabs/backend` |
| `artifacts/dashboard/**` | `@gheeklabs/frontend` |
| `docker/**` | `@gheeklabs/infra` |
| `lib/**` | `@gheeklabs/core` + specific teams |
| `.github/**` | `@gheeklabs/core` |

**Teams must exist in the GitHub organization before CODEOWNERS takes effect.** Create these teams under **Settings → Teams** and add appropriate members.

---

## Label sync

Labels are managed as code in `.github/labels.yml`. The `sync-labels.yml` workflow runs automatically on push to `main` when `labels.yml` changes.

To force a full sync (e.g. after setting up a new repo):

1. Go to **Actions → Sync Labels**.
2. Click **Run workflow** → **Run workflow**.

Do not create or modify labels manually in the GitHub UI — they will be overwritten on the next sync.

---

## Dependabot

Dependabot is configured in `.github/dependabot.yml` for:

- **npm at `/`** — weekly, Monday 08:00 UTC, grouped into `dependencies` and `devDependencies` PRs.
- **GitHub Actions** — weekly, Monday 08:00 UTC, all action updates grouped into one PR.

**Per-subdirectory npm** (`/artifacts/api-server`, `/artifacts/dashboard`) is intentionally deferred. Before adding subdirectory entries, validate on a test branch that Dependabot correctly updates the root `pnpm-lock.yaml` without divergence when processing monorepo workspace packages. Known pnpm lockfile edge cases can cause `pnpm install --frozen-lockfile` failures on Dependabot PRs if subdirectory entries are added prematurely.

---

## Release automation

`release.yml` runs on every push to `main` (excluding `github-actions[bot]` actor to prevent loops).

### Ruleset bypass for release commits

`release.yml` pushes a changelog commit directly to `main` (the `chore(release): vX.Y.Z [skip ci]` commit) and creates a version tag. If branch protection or rulesets later require a PR before merging, this push will fail.

Before enabling "Require a pull request before merging", configure a ruleset bypass:

1. Go to **Settings → Rules → Rulesets** (or **Branches → Protection rules**).
2. Find the `main` branch rule.
3. Under **Bypass list**, add **GitHub Actions** (the `github-actions[bot]` actor) with **bypass mode: Always**.
4. Alternatively, use a fine-grained PAT scoped to `contents: write` stored as `RELEASE_TOKEN` and replace `${{ secrets.GITHUB_TOKEN }}` in `release.yml`.

> If you use a fine-grained PAT instead of bypassing `github-actions[bot]`, the bot-loop guard in `release.yml` (`if: github.actor != 'github-actions[bot]'`) must be updated to match the PAT's actor identity.

### Version bump logic

| Commit type | Bump |
|---|---|
| `BREAKING CHANGE` in body/footer, or `!` suffix | **major** |
| `feat:` | **minor** |
| `fix:`, `hotfix:`, `refactor:`, `perf:` | **patch** |
| `docs:`, `ci:`, `chore:`, `build:`, `test:` only | **no bump** — clean exit |

A `CHANGELOG.md` entry is created only when a version is actually incremented. The release commit is tagged `vX.Y.Z` and a GitHub Release is created with auto-generated notes.

---

## Layer 2 (Task #133)

The following are **out of scope for this runbook** and will be configured as part of Task #133:

- CodeQL scanning workflow and required check enrollment.
- Preview deployments on PRs.
- Build attestations for Docker images.
- Merge queue refinements post-soak.
