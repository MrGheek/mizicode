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
| `CodeQL analysis (javascript-typescript)` | `codeql.yml` | **Required** — enrolled 2026-05-06 after soak period review (Task #182) |
| `Apply component labels` | `pr-labeler.yml` | Optional — informational only |

> **Important — required check strategy**: `ci-all.yml` intentionally does **not** use `paths-ignore`. Required status checks must run on every PR (including docs-only PRs) or GitHub branch protection will block the merge when the required check never fires. The path-filter matrix inside `ci.yml` handles build job skipping efficiently — the `TypeScript type-check` job always runs quickly, so docs-only PRs complete CI in ~1 minute without running expensive build steps.
>
> Do **not** add `paths-ignore` to `ci-all.yml` or any workflow whose jobs are marked as required checks. Only add `paths-ignore` to purely informational workflows.

> **Note on CodeQL**: CodeQL checks (added in Task #133) ran as *informational* checks during a 2-week soak period (2026-04-22 – 2026-05-06). The soak period review (Task #182) found zero false positives and no incorrectly flagged PRs. `CodeQL analysis (javascript-typescript)` is now a **required** blocking check on all PRs and in the merge queue as of 2026-05-06.

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

## Layer 2 — Additional CI/CD hardening

This section covers all manual GitHub settings that must be applied after the Layer 2 workflow files are merged. Layer 2 adds merge queue refinements, CodeQL scanning, dashboard PR previews, Docker image attestations, and secret scanning.

> **Recommended rollout order for Layer 2:**
> 1. Merge the Layer 2 workflow PR (adds `codeql.yml`, `preview-dashboard.yml`, attestation step to `docker-build.yml`).
> 2. Create the `preview` GitHub Environment with its secrets (see below).
> 3. Enable merge queue on `main` (see below).
> 4. Enable secret scanning and push protection (see `.github/security-hardening.md`).
> 5. Observe CodeQL results for 1–2 weeks before deciding whether to make it a required check.
> 6. Configure the FLOATR Project board following `.github/projects.md`.

---

### Enabling merge queue on `main`

Merge queue is a branch protection feature that serializes merges by re-running CI on the combined result of multiple PRs before any of them land on `main`.

**Steps:**

1. Go to **Settings → Branches → Branch protection rules** (or **Rulesets**).
2. Edit the `main` rule.
3. Enable **Require merge queue**.
4. Set **Merge method**: Squash.
5. Set **Minimum group size**: 1, **Maximum group size**: 5, **Wait time**: 5 minutes.

**Which checks to mark as required in the merge queue:**

Use the exact job `name:` strings from the workflows. The merge queue exposes these as separate check entries from the PR checks — add both sets.

| Check name | Workflow | Notes |
|---|---|---|
| `TypeScript type-check` | `ci.yml` | Required |
| `Validate PR title (conventional commits)` | `commitlint.yml` | Required |
| `Lint workflow files with actionlint` | `workflow-hygiene.yml` | Required |
| `CodeQL analysis (javascript-typescript)` | `codeql.yml` | **Required** — enrolled 2026-05-06 after soak period review |

> The `commitlint.yml` workflow now triggers on `merge_group` so commit validation runs inside the queue. The `ci-all.yml` already had `merge_group` support from Layer 1.

---

### Creating the `preview` GitHub Environment

The `preview-dashboard.yml` workflow deploys dashboard previews using secrets from a `preview` GitHub Environment. This Environment must be created manually.

**Steps:**

1. Go to **Settings → Environments → New environment**.
2. Name it exactly: `preview`.
3. Under **Environment secrets**, add the following for the default Vercel provider:

| Secret name | Description | Where to find it |
|---|---|---|
| `PREVIEW_VERCEL_TOKEN` | Vercel API token | vercel.com → Account Settings → Tokens |
| `PREVIEW_VERCEL_ORG_ID` | Vercel team or personal account ID | vercel.com → Account Settings → General → Team ID |
| `PREVIEW_VERCEL_PROJECT_ID` | Vercel project ID | vercel.com → Project Settings → General |

4. Optionally, add **Deployment protection rules** (e.g. require a reviewer — not needed for `preview`).

**Verifying secrets without opening a PR:** After adding the three secrets above, run the workflow manually to confirm the credentials work before merging any real PR:

1. Go to **Actions → Preview — Dashboard**.
2. Click **Run workflow**, choose the branch you want to deploy (e.g. `main`), and click **Run workflow**.
3. Open the completed run and check the **Summary** tab — a successful deploy prints the preview URL there.
4. If the run fails, the error message in the "Deploy to preview (Vercel)" step will tell you which secret is missing or invalid.

This is the recommended verification step any time secrets are rotated or the `preview` Environment is recreated.

**Switching providers:** To use a provider other than Vercel, replace the "Deploy to preview (Vercel)" step in `preview-dashboard.yml` with your provider's CLI command. The step must write `echo "url=<preview-url>" >> "$GITHUB_OUTPUT"` and populate the corresponding secrets in the `preview` Environment.

---

### CodeQL — soak period and required-check enrollment

`codeql.yml` runs on every PR, push to `main`, and weekly schedule. It is **not** a required check initially.

**Soak period process:**

1. After merging Layer 2, monitor the **Security → Code scanning** tab for 1–2 weeks.
2. Review each alert: determine if it is a true positive (real vulnerability) or false positive (noise from test fixtures, generated code, etc.).
3. Dismiss false positives with the "False positive" or "Used in tests" reason so they do not reappear.
4. If the alert rate is acceptable (low false positives, manageable true positives), proceed to enrollment.

**Enrolling CodeQL as a required check:**

1. Go to **Settings → Branches → edit the `main` rule**.
2. Under **Require status checks to pass**, add: `CodeQL analysis (javascript-typescript)`.
3. Add the same check to the merge queue required checks.
4. Communicate to the team that CodeQL is now blocking.

**Soak period tracking log:**

| Date | Event | Notes |
|---|---|---|
| 2026-04-22 | SHA pins verified & updated; soak period started | All action SHAs updated to current stable releases (see table below). Soak review target: **2026-05-06** |
| 2026-05-06 | Soak period review completed; decision: **enrol** | Code scanning alerts reviewed — 0 false positives observed during soak, no PRs incorrectly flagged, average run time under 10 minutes. Team decided to enrol. |
| 2026-05-06 | `CodeQL analysis (javascript-typescript)` added as required check | Added to branch protection required checks on `main` AND to merge queue required checks per steps in the enrollment section above. |

> **Enrollment complete (2026-05-06)**: `CodeQL analysis (javascript-typescript)` is now a required blocking check on all PRs and in the merge queue. See `.github/CODEQL_SOAK_REVIEW.md` for the full review record.

---

### SHA pin verification log

All SHA pins in `.github/workflows/codeql.yml` and `.github/workflows/preview-dashboard.yml` (and other shared workflows) were verified against the GitHub releases pages on **2026-04-22** and updated to the following current stable releases:

| Action | Previous version | Updated to | Commit SHA |
|---|---|---|---|
| `actions/checkout` | v4.2.2 | **v6.0.2** | `de0fac2e4500dabe0009e67214ff5f5447ce83dd` |
| `actions/setup-node` | v4.2.0 | **v6.4.0** | `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` |
| `pnpm/action-setup` | v4.0.0 | **v5.0.0** | `fc06bc1257f339d1d5d8b3a19a8cae5388b55320` |
| `github/codeql-action/{init,autobuild,analyze}` | v3.26.0 | **v4.35.2** | `95e58e9a2cdfd71adc6e0353d5c52f41a045d225` |
| `peter-evans/find-comment` | v3.1.0 | **v4.0.0** | `b30e6a3c0ed37e7c023ccd3f1db5c6c0b0c23aad` |
| `peter-evans/create-or-update-comment` | v4.0.0 | **v5.0.0** | `e8674b075228eee787fea43ef493e45ece1004c9` |

SHAs were obtained directly from the GitHub release pages for each action. Dependabot (`github-actions` entry in `.github/dependabot.yml`, `directory: "/"`) will keep these pins current going forward via weekly Monday PRs.

> **Note on `github/codeql-action` v3 → v4**: CodeQL Action v3 was still supported at time of update but is scheduled for deprecation with GHES 3.19 (December 2026). The upgrade to v4 ensures the workflow tracks the actively maintained major version with Node.js 24 runtime support.

---

### Docker image attestations

`docker-build.yml` now generates SLSA provenance attestations after each image push using `actions/attest-build-provenance`. No additional configuration is required — the workflow uses the built-in OIDC token (`id-token: write`).

**Verifying an attestation:**

```bash
gh attestation verify oci://docker.io/gheeklabs/coding-env:latest \
  --owner gheeklabs
```

Expected output:

```
Loaded digest sha256:<digest> for oci://docker.io/gheeklabs/coding-env:latest
Successfully verified 1 attestation(s).

The following attestations matched the predicate type "https://slsa.dev/provenance/v1":
  - Predicate type: https://slsa.dev/provenance/v1
  - Workflow:       .github/workflows/docker-build.yml@refs/heads/main
  - Repository:     gheeklabs/<repo>
  - Signer:         ...
```

If verification fails, check that:
- The image was built from a `push` to `main` (not a manual `workflow_dispatch` run without the expected ref).
- `id-token: write` is present in the job permissions (it is).
- The `gh` CLI is authenticated: `gh auth login`.

---

### Secret scanning and push protection

See `.github/security-hardening.md` for the full ops guide covering:
- How to enable secret scanning and push protection in **Settings → Code security and analysis**.
- What contributors see when a push is blocked.
- How to request and review bypasses.
- Credential types especially relevant to FLOATR.
- Onboarding checklist for new contributors.

---

### FLOATR Project board

See `.github/projects.md` for the full runbook covering:
- Recommended board fields (Status, Component, Priority, Owner, Milestone/Release).
- Built-in GitHub Project automations to configure (auto-add, status transitions, archive delay).
- How to map `component:*` and `priority:*` labels to Project select fields.
- Step-by-step board creation instructions.
