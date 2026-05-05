# MIZI Engineering Project Board — Ops Runbook

This document describes the intended configuration for the MIZI engineering GitHub Project board. All automation described here uses **GitHub's built-in Project automations** — no custom workflow code is required or added.

---

## Board fields

| Field | Type | Purpose |
|---|---|---|
| **Status** | Single select | Tracks where an item is in the workflow (see values below) |
| **Component** | Single select | Maps to `component:*` labels (dashboard, api-server, docker, ci, docs, lib) |
| **Priority** | Single select | Maps to `priority:*` labels (critical, high, medium, low) |
| **Owner** | Text / Person | Assigned team member or GitHub username |
| **Milestone / Release** | Iteration or text | Links to a GitHub Milestone or target release version |

### Status column values (recommended order)

| Value | Meaning |
|---|---|
| **Triage** | New item, not yet reviewed |
| **Todo** | Accepted and ready to be worked on |
| **In Progress** | Actively being worked on |
| **In Review** | PR open, awaiting review or CI |
| **Done** | Merged/closed |
| **Archived** | Done and swept from the active board after a delay |

---

## Built-in GitHub Project automations to configure

Navigate to the Project board → **Settings → Workflows** (the built-in automation tab) and enable the following rules. No YAML or code needed.

### Auto-add items

| Trigger | Action | Notes |
|---|---|---|
| Issue opened in this repo | Add to project | Sets Status = **Triage** |
| Pull request opened in this repo | Add to project | Sets Status = **Triage** |

> After enabling, GitHub will prompt you to set the default Status for auto-added items. Choose **Triage**.

### Status transitions

| Trigger | Action |
|---|---|
| Pull request opened or reopened | Set Status → **In Review** |
| Pull request merged | Set Status → **Done** |
| Issue closed (any reason) | Set Status → **Done** |

### Archiving

| Trigger | Action |
|---|---|
| Item Status set to **Done** | Archive after 14 days |

GitHub Projects provides a built-in "Archive item" automation that fires on a status change with an optional delay. Use the 14-day delay to keep recently-completed work visible for retrospectives before it leaves the active board.

---

## Mapping labels to Project fields

The `component:*` and `priority:*` labels from `.github/labels.yml` should be mirrored into the corresponding Project select fields when items are added. GitHub's built-in automations do not yet auto-populate custom fields from labels, so this mapping is maintained manually (or by a future automation):

| Label | Project field | Value |
|---|---|---|
| `component:dashboard` | Component | `dashboard` |
| `component:api-server` | Component | `api-server` |
| `component:docker` | Component | `docker` |
| `component:ci` | Component | `ci` |
| `component:docs` | Component | `docs` |
| `component:lib` | Component | `lib` |
| `priority:critical` | Priority | `critical` |
| `priority:high` | Priority | `high` |
| `priority:medium` | Priority | `medium` |
| `priority:low` | Priority | `low` |

When triaging a new issue or PR, apply the relevant labels in GitHub — the label sidebar populates the issue automatically. Then set the corresponding Project fields manually or via a future automation rule.

---

## Creating the board

1. Go to **github.com/orgs/gheeklabs/projects** (or the repo's **Projects** tab) → **New project** → **Board** or **Table** view.
2. Name it `MIZI Engineering`.
3. Add the fields from the table above (Status and Component are single-select; Priority is single-select; Owner is a person field; Milestone is text or iteration).
4. Configure the Status column values in the listed order.
5. Enable the built-in automations described above under **Settings → Workflows**.
6. Pin the project to the repository under the repo's **Projects** tab so it appears in the sidebar.

---

## Notes

- GitHub Projects automations are **eventually consistent** — there may be a short delay between an event (PR merge) and the status update.
- The board should be reviewed and groomed in the weekly engineering sync. Archive any stale **Done** items that have lingered beyond two weeks.
- For sprints, use the **Iteration** field type for Milestone/Release instead of plain text.
