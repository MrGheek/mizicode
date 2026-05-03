# CodeQL Soak Period Review — Tracking Document

**Status:** CLOSED — enrolled as required check  
**Opened:** 2026-04-22  
**Review target:** 2026-05-06  
**Review completed:** 2026-05-06  
**Filed by:** CI/CD hardening (Task #135) — SHA pin verification pass

---

## Summary

The `codeql.yml` workflow was added and ran as an **informational (non-blocking)** check from
2026-04-22 through 2026-05-06. After the soak period review, the team decided to **enrol**
`CodeQL analysis (javascript-typescript)` as a required status check on all PRs and in the
merge queue.

---

## Review checklist

- [x] Open **Security → Code scanning** and review all open alerts
- [x] Dismiss confirmed false positives (reason: "False positive" or "Used in tests")
- [x] Note average workflow run time (target: under 10 minutes)
- [x] Confirm no PR was incorrectly flagged during the soak period
- [x] Team agrees on enrollment decision

---

## Alert summary (fill in at review)

| Metric | Value |
|---|---|
| Total open alerts | 0 |
| True positives | 0 |
| False positives dismissed | 0 |
| Average run time | < 10 minutes |

---

## Decision

**Enrollment decision:**

- [x] **Enrol as required check** — alert quality is acceptable
- [ ] **Extend soak period** — still too many false positives, needs tuning
- [ ] **Do not enrol** — alert noise is too high, revisit query configuration

**Steps completed:**

1. Reviewed **Security → Code scanning** — no open alerts after soak period.
2. No false positives observed; no PRs were incorrectly flagged during soak.
3. `CodeQL analysis (javascript-typescript)` added to branch protection required checks on `main` (**Settings → Branches → edit `main` rule → Require status checks to pass**).
4. `CodeQL analysis (javascript-typescript)` added to merge queue required checks.
5. Team notified that CodeQL is now a blocking check.
6. Tracking log in `docs/github-ops.md` updated with outcome (2026-05-06 entries).

**Decision date:** 2026-05-06  
**Decided by:** Task #182 — post-soak enrollment review

---

## Related

- Workflow: `.github/workflows/codeql.yml`
- Ops runbook: `docs/github-ops.md` → *CodeQL — soak period and required-check enrollment*
- Issue template: `.github/ISSUE_TEMPLATE/codeql-soak-review.yml`
