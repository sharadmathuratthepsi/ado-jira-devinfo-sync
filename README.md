# ado-jira-devinfo-sync

Makes Azure DevOps **pull requests, branches, and commits** that reference a
`DP-<n>` Jira key show up in that issue's **Development** panel — for free, with
no BDO involvement and no Azure DevOps admin/write access.

## How it works

```
GitHub Actions (cron every 15 min — free, always-on)
  1. read Azure DevOps PRs / branches / commits   ── ADO PAT, READ-ONLY
  2. parse DP-<n> from PR title/description/branch + commit messages
  3. get a Jira token   ── client_credentials (2LO OAuth), no user login
  4. POST to the Jira DevInfo bulk API  (issueKeys: ["DP-<n>"])
  5. → appears in each DP issue's Development panel, links click through to ADO
```

- **Read-only on Azure DevOps.** The PAT needs only `Code: Read`. No webhook (that
  would need ADO admin) — sync is a scheduled poll, so updates land within ~15 min.
- **Jira side** uses a 2LO OAuth credential (`manage:jira-data-provider` scope)
  created by a Jira admin at **Settings → Apps → OAuth credentials**. Built into
  Jira Cloud, free.
- **Idempotent.** Safe to re-run; `updateSequenceId` is derived from timestamps so a
  later run always wins. Entities with no `DP-<n>` are skipped.

## Setup

### 1. Jira 2LO OAuth credential
Jira (`fashionuk.atlassian.net`) → **Settings (cog) → Apps → OAuth credentials →
Create credential**. Name `ado-devinfo-sync`, Server base URL
`https://dev.azure.com/fashion-uk`, permissions **Development information + Builds +
Deployments**. Copy the **Client ID** + **Secret**.

### 2. Azure DevOps PAT (read-only)
ADO → **User settings → Personal Access Tokens → New Token**. Org `fashion-uk`,
scope **Code: Read** only. Copy the token.

### 3. GitHub repo secrets
This repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
| --- | --- |
| `JIRA_CLIENT_ID` | from step 1 |
| `JIRA_CLIENT_SECRET` | from step 1 |
| `JIRA_CLOUD_ID` | `c766fbc8-74bf-48ef-a9f1-b369e54bb2f3` (fashionuk tenant) |
| `ADO_PAT` | from step 2 |

Then the workflow (`.github/workflows/sync.yml`) runs on a 15-min cron. Trigger a
first run manually: **Actions → ado-jira-devinfo-sync → Run workflow**.

## Run locally
```bash
JIRA_CLIENT_ID=… JIRA_CLIENT_SECRET=… JIRA_CLOUD_ID=… ADO_PAT=… \
  node sync.mjs
# DRY_RUN=1 to print the payload without pushing to Jira.
```

## Config (env)
`ADO_ORG` (default `fashion-uk`), `ADO_PROJECT`/`ADO_REPO` (default `Design_Portal`),
`COMPLETED_DAYS` (default 30 — how far back completed PRs are pushed).
`ADO_BEARER` may be set instead of `ADO_PAT` (e.g. an `az`-minted token for local
testing).
