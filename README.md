# ado-jira-devinfo-sync

Connects Azure DevOps to Jira Cloud (project **DP**) — **free**, with **no BDO
involvement** and **no Azure DevOps admin/write** access. Two pieces, both driven
off the same read-only poll of Azure DevOps, on a ~15-min schedule:

1. **`sync.mjs` — Development panel.** PRs / branches / commits that reference a
   `DP-<n>` key show up in that issue's **Development** panel, links clicking
   through to Azure DevOps.
2. **`transitions.mjs` — workflow automation.** DP issue **status** auto-advances
   along the "DP Delivery Workflow" as the work moves in Azure DevOps.

## How it works

```
external cron (cron-job.org, ~15 min) → POST workflow_dispatch → GitHub Actions run
  read Azure DevOps PRs / branches / commits          ── ADO PAT, READ-ONLY (Code: Read)
  ├─ sync.mjs        parse DP-<n> → POST Jira DevInfo bulk API (2LO OAuth)
  │                  → Development panel populated
  └─ transitions.mjs parse DP-<n> → compute target status → Jira REST transition
                     (user API token) → status auto-advances
```

- **Read-only on Azure DevOps.** The PAT needs only `Code: Read`. No webhook (that
  would need ADO admin = BDO) — it is a scheduled poll, so updates land within ~15 min.
- **Team-wide, no per-dev setup.** The poll reacts to events by anyone (any tool);
  one set of service credentials drives everything.
- **Trigger:** an external cron (cron-job.org, free) POSTs to the GitHub
  `workflow_dispatch` API every ~15 min — GitHub's own scheduled-cron is unreliable
  to activate on a new repo, so it is not used. The cron-job.org token is a
  fine-grained PAT scoped to this repo with **Actions: read/write**, held only in
  cron-job.org.

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
- **A manual reset sticks.** Forward-only is not enough on its own: it asks only
  "is the target higher than where this is now?", and nothing records *why* the
  ticket is where it is. So a human correcting a wrongly-advanced ticket was
  silently undone — the next run re-read the same merged PR, saw To Do, and
  advanced it again, every ~5 minutes. (Seen on DP-169/DP-170, which a **docs**
  PR marked Development Complete: the PR title mentioned the keys, and the
  connector does not distinguish "we wrote the story" from "we built it".)

  Now, when a **person** moves an issue *down* the pipeline, that status becomes
  a **floor**. Automation will not climb past it on evidence that already
  existed — only on an event that first appeared **after** the manual move. A PR
  merged last week cannot re-advance a ticket reset this morning; a PR merged
  this afternoon can. Human moves are told from automated ones by the
  `historyMetadata` stamp the connector already writes, so this needs no external
  state — it reads Jira's own changelog. Evidence with no timestamp (a bare
  branch ref) is treated as not-provably-new and holds.
- **Idempotent.** A move (and its single comment) fires only when the status
  actually changes — re-running every cycle does not spam.
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

### 5. External cron trigger (cron-job.org)
GitHub's native scheduled-cron is unreliable to activate on a new repo, so an
external free cron drives the dispatch. In [cron-job.org](https://cron-job.org):
- **URL:** `https://api.github.com/repos/sharadmathuratthepsi/ado-jira-devinfo-sync/actions/workflows/sync.yml/dispatches`
- **Method:** POST · **every ~15 min**
- **Headers:** `Accept: application/vnd.github+json`, `Authorization: Bearer <fine-grained PAT>`, `X-GitHub-Api-Version: 2022-11-28`
- **Body:** `{"ref":"main"}`
- The PAT is fine-grained, scoped to **only this repo**, permission **Actions: read
  and write** — held only in cron-job.org, never in git.

Trigger a run manually anytime: **Actions → ado-jira-devinfo-sync → Run workflow**.

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
