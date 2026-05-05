# Security Hardening — Secret Scanning & Push Protection

This document covers how to enable GitHub secret scanning and push protection for this repository, what contributors experience when a push is blocked, and the credential types most relevant to MIZI.

---

## Enabling secret scanning and push protection

Navigate to **Settings → Code security and analysis** in the GitHub repository.

| Setting | Action |
|---|---|
| **Secret scanning** | Click **Enable** |
| **Push protection** | Click **Enable** (requires secret scanning to be active first) |

Both settings are available on GitHub Free for public repositories and GitHub Advanced Security for private repositories on Team/Enterprise plans.

After enabling, GitHub scans all new commits automatically. It also performs a one-time historical scan of the full repository history and surfaces any findings under **Security → Secret scanning**.

---

## What contributors see when a push is blocked

When push protection detects a secret, the `git push` command fails with a pre-receive hook error similar to:

```
remote: Push rejected.
remote:
remote: GitHub found a secret in the following commit(s):
remote:   Commit: abc1234
remote:   File:   .env
remote:   Secret type: anthropic_api_key
remote:   Location: line 7
remote:
remote: To push this commit, first remove the secret and rebase your branch.
remote: If the secret is no longer active, you can bypass push protection:
remote:   https://github.com/gheeklabs/<repo>/security/secret-scanning/unblock-secret/<token>
remote:
To https://github.com/gheeklabs/<repo>.git
 ! [remote rejected] feature/my-branch -> feature/my-branch (push declined due to repository rule violations)
```

The contributor must either:
1. **Remove the secret** from the commit history (rebase, filter-branch, or BFG) and push the cleaned branch, **or**
2. **Request a bypass** using the URL provided in the error output.

---

## Requesting a bypass

Bypass requests are reviewed by repository administrators or organization security managers.

**Process:**
1. Click the bypass URL in the push rejection message.
2. Select a reason: "It's used in tests", "It's a false positive", or "I'll fix this later".
3. An administrator or security manager reviews the request under **Settings → Code security → Push protection bypasses**.
4. If approved, the contributor receives an email and can re-push.

**Who reviews:** By default, any user with **Admin** access to the repository can approve bypass requests. Consider restricting this to a dedicated security reviewer role.

**Policy:** Bypasses should only be approved for:
- Confirmed false positives (e.g. a placeholder value that matches a secret pattern but contains no real credential).
- Test fixtures that use dummy values verified to be inactive.

Any bypass for a credential that might be live should be rejected. The contributor must rotate the credential and remove it from history.

---

## Credential types especially relevant to MIZI

| Credential | Secret type GitHub detects | Where it appears |
|---|---|---|
| **Vast.ai API key** | Custom pattern (may require custom secret scanning config) | `~/.vastai/api_key`, `.env`, scripts |
| **DockerHub token** (`DOCKERHUB_TOKEN`) | `dockerhub_access_token` | `.env`, CI configs, Docker login scripts |
| **Anthropic API key** | `anthropic_api_key` | `.env`, `config.json`, prompt scripts |
| **PostgreSQL DSN / connection string** | `postgres_connection_string` | `.env`, `drizzle.config.ts`, migration scripts |
| **GitHub PAT** | `github_personal_access_token` | Scripts, `.env`, CI configs |

### Rotation checklist

If any of these credentials are found in the repository (current or historical):

1. **Immediately revoke** the exposed credential in the relevant service's dashboard.
2. **Generate a new credential** and store it in GitHub repository secrets (via **Settings → Secrets and variables → Actions**) — never in code.
3. **Clean the history** using `git filter-repo` or BFG Repo Cleaner, then force-push (after coordinating with the team).
4. **Audit logs** in the relevant service to check for unauthorized access during the exposure window.

---

## Onboarding checklist for new contributors

Before pushing your first commit to this repository, confirm the following:

- [ ] I have read this document.
- [ ] My local environment stores secrets in `.env` files that are listed in `.gitignore` — I will not commit `.env` files.
- [ ] I do not hardcode API keys, tokens, passwords, or DSNs in source files. I reference them via environment variables only.
- [ ] I know how to check if a secret is about to be committed: `git diff --staged` or `git log -p` before pushing.
- [ ] If push protection blocks my push, I know to rotate the credential immediately and contact a repository admin rather than bypassing without justification.
- [ ] I have confirmed that the repository's `.gitignore` covers `.env`, `.env.*`, `*.pem`, `*.key`, and similar sensitive file patterns.

---

## Additional resources

- [GitHub: About secret scanning](https://docs.github.com/en/code-security/secret-scanning/about-secret-scanning)
- [GitHub: About push protection](https://docs.github.com/en/code-security/secret-scanning/about-push-protection)
- [BFG Repo Cleaner](https://rtyley.github.io/bfg-repo-cleaner/) — fast history rewriting for removing secrets
- [git-filter-repo](https://github.com/newren/git-filter-repo) — the modern, recommended history rewriting tool
