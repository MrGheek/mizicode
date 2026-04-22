# CodeQL Soak Period Review — Tracking Document

**Status:** OPEN — awaiting 2-week soak period observation  
**Opened:** 2026-04-22  
**Review target:** 2026-05-06  
**Filed by:** CI/CD hardening (Task #135) — SHA pin verification pass

---

## Summary

The `codeql.yml` workflow was added and is running as an **informational (non-blocking)** check.
Before making it a required status check, the team must observe alert quality for 1–2 weeks.

This file is the concrete tracking artifact for that review.
Once the review is complete, update the **Decision** section below and close/archive this file.

---

## Review checklist

- [ ] Open **Security → Code scanning** and review all open alerts
- [ ] Dismiss confirmed false positives (reason: "False positive" or "Used in tests")
- [ ] Note average workflow run time (target: under 10 minutes)
- [ ] Confirm no PR was incorrectly flagged during the soak period
- [ ] Team agrees on enrollment decision

---

## Alert summary (fill in at review)

| Metric | Value |
|---|---|
| Total open alerts | |
| True positives | |
| False positives dismissed | |
| Average run time | |

---

## Decision

**Enrollment decision:**

- [ ] **Enrol as required check** — alert quality is acceptable
- [ ] **Extend soak period** — still too many false positives, needs tuning
- [ ] **Do not enrol** — alert noise is too high, revisit query configuration

**If enrolling, steps to complete:**

1. Go to **Settings → Branches → edit the `main` protection rule**
2. Under **Require status checks to pass**, add: `CodeQL analysis (javascript-typescript)`
3. Add the same check to the merge queue required checks
4. Announce to the team that CodeQL is now a blocking check
5. Update the tracking log in `docs/github-ops.md` with the outcome

**Decision date:** _(fill in)_  
**Decided by:** _(fill in)_

---

## Related

- Workflow: `.github/workflows/codeql.yml`
- Ops runbook: `docs/github-ops.md` → *CodeQL — soak period and required-check enrollment*
- Issue template: `.github/ISSUE_TEMPLATE/codeql-soak-review.yml`
