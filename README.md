# ado-jira-devinfo-sync

Connects Azure DevOps to Jira Cloud (project **DP**) — **free**, with **no BDO
involvement** and **no Azure DevOps admin/write** access. Two pieces, both driven
off the same read-only poll of Azure DevOps on a GitHub Actions cron:

1. **`sync.mjs` — Development panel.** PRs / branches / commits that reference a
   `DP-<n>` key show up in that issue's **Development** panel, links clicking
   through to Azure DevOps.
2. **`transitions.mjs` — workflow automation.** DP issue **status** auto-advances
   along the "DP Delivery Workflow" as the work moves in Azure DevOps.

## How it works

```
GitHub Actions (cron every ~1 min — free, always-on)
  read Azure DevOps PRs / branches / commits          ── ADO PAT, READ-ONLY (Code: Read)
  ├─ sync.mjs        parse DP-<n> → POST Jira DevInfo bulk API (2LO OAuth)
  │                  → Development panel populated
  └─ transitions.mjs parse DP-<n> → compute target status → Jira REST transition
                     (user API token) → status auto-advances
```

- **Read-only on Azure DevOps.** The PAT needs only `Code: Read`. No webhook (that
  would need ADO admin = BDO) — it is a scheduled poll, so updates land within ~1 min.
- **Team-wide, no per-dev setup.** The poll reacts to events by anyone (any tool);
  one set of service credentials drives everything.

### Auto-transitions (`transitions.mjs`)

Forward-only moves along the workflow:

| Azure DevOps event | → Jira status |
| --- | --- |
| branch exists / ≥1 commit for `DP-<n>` | In Development |
| PR open | PR Raised |
| PR approved (reviewer vote ≥ 10, none rejected) | PR Reviewed |
| PR merged to `develop` | Development Complete |

Safety:

- **Forward-only.** Never regresses a ticket — if its current status is already at
  or beyond the target's pipeline rank, it is left untouched (manual advances always
  win). Multi-stage gaps are walked up one valid transition at a time.
- **Idempotent.** A move (and its single comment) fires only when the status
  actually changes — re-running every minute does not spam.
- **Epics excluded** — an epic tracks many children; it is never moved on one PR.
- **Attributed as automated** — each move carries `historyMetadata` ("Automated by
  ADO↔Jira Sync") and posts one comment naming the trigger, so the activity log
  shows it was automatic.

## Setup

### 1. Jira 2LO OAuth credential (for the DevInfo panel)
Jira (`fashionuk.atlassian.net`) → **Settings (cog) → Apps → OAuth credentials →
Create credential**. Name `ado-devinfo-sync`, Server base URL
`https://dev.azure.com/fashion-uk`, permissions **Development information + Builds +
Deployments**. Copy the **Client ID** + **Secret**.

### 2. Jira API token (for the auto-transitions)
[id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
→ Create API token → label `ado-jira-sync`. This is a **user** token (basic auth);
its holder needs transition rights on project DP. Auto-transitions are attributed to
this account (the automated stamp + comment make clear it was automatic).

### 3. Azure DevOps PAT (read-only)
ADO → **User settings → Personal Access Tokens → New Token**. Org `fashion-uk`,
scope **Code: Read** only. Copy the token.

### 4. GitHub repo secrets
This repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | For | Value |
| --- | --- | --- |
| `JIRA_CLIENT_ID` | panel | from step 1 |
| `JIRA_CLIENT_SECRET` | panel | from step 1 |
| `JIRA_CLOUD_ID` | panel | `c766fbc8-74bf-48ef-a9f1-b369e54bb2f3` (fashionuk tenant) |
| `JIRA_USER_EMAIL` | transitions | your Jira account email |
| `JIRA_API_TOKEN` | transitions | from step 2 |
| `ADO_PAT` | both | from step 3 |

The transition step **auto-skips** if `JIRA_API_TOKEN` is not set — so the DevInfo
panel works on its own; add the token later to turn on auto-transitions.

Then the workflow runs on a ~1-min cron. Trigger the first run manually:
**Actions → ado-jira-devinfo-sync → Run workflow**.

## Run locally
```bash
# Development panel
JIRA_CLIENT_ID=… JIRA_CLIENT_SECRET=… JIRA_CLOUD_ID=… ADO_PAT=… node sync.mjs
# DRY_RUN=1 to print the payload without pushing.

# Auto-transitions
JIRA_USER_EMAIL=… JIRA_API_TOKEN=… ADO_PAT=… node transitions.mjs
# DRY_RUN=1 to log the intended transitions without applying — ALWAYS dry-run first.
```

## Config (env)
`ADO_ORG` (default `fashion-uk`), `ADO_PROJECT`/`ADO_REPO` (default `Design_Portal`),
`COMPLETED_DAYS` (default 30 — how far back completed PRs are considered).
`JIRA_SITE` (default `fashionuk.atlassian.net`). `ADO_BEARER` may be set instead of
`ADO_PAT` (e.g. an `az`-minted token for local testing).
