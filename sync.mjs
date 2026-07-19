#!/usr/bin/env node
// ADO -> Jira DevInfo sync. No deps (Node 20+ global fetch).
//
// Reads Azure DevOps (read-only PAT): active + recently-completed PRs, all
// DP-<n> branches, and their tip commits. Parses the DP-<n> key from the PR
// branch name + title (NOT the description — see the PR loop) and from commit
// messages. Pushes everything to the Jira DevInfo bulk API so it shows in each
// DP issue's Development panel.
//
// Idempotent: safe to re-run. updateSequenceId is derived from timestamps so a
// later run always wins. Entities with no DP-<n> key are skipped.
//
// Env:
//   JIRA_CLIENT_ID, JIRA_CLIENT_SECRET, JIRA_CLOUD_ID   (Jira 2LO OAuth creds)
//   ADO_PAT                                              (ADO PAT, Code:Read)
//   ADO_ORG      default "fashion-uk"
//   ADO_PROJECT  default "Design_Portal"
//   ADO_REPO     default "Design_Portal"
//   COMPLETED_DAYS default 30   (how far back completed PRs are pushed)
//   DRY_RUN      "1" to log the payload and skip the Jira push

const {
  JIRA_CLIENT_ID, JIRA_CLIENT_SECRET, JIRA_CLOUD_ID, ADO_PAT,
  ADO_BEARER, // optional: use a bearer token instead of a PAT (e.g. az-minted for local test)
  ADO_ORG = 'fashion-uk',
  ADO_PROJECT = 'Design_Portal',
  ADO_REPO = 'Design_Portal',
  COMPLETED_DAYS = '30',
  DRY_RUN = '',
} = process.env;

for (const [k, v] of Object.entries({ JIRA_CLIENT_ID, JIRA_CLIENT_SECRET, JIRA_CLOUD_ID })) {
  if (!v) { console.error(`missing env: ${k}`); process.exit(1); }
}
if (!ADO_PAT && !ADO_BEARER) { console.error('missing env: ADO_PAT (or ADO_BEARER)'); process.exit(1); }

const DP_RE = /\bDP-\d+\b/gi;
const keysFrom = (...strs) => {
  const set = new Set();
  for (const s of strs) for (const m of String(s || '').matchAll(DP_RE)) set.add(m[0].toUpperCase());
  return [...set];
};
// DevInfo branch id bans "/" — must match [A-Za-z0-9-._~]+
const branchId = (name) => name.replace(/\//g, '.');
const seq = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 1; };
const clip = (s, n = 1024) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

const ADO_BASE = `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_apis/git/repositories/${ADO_REPO}`;
const ADO_WEB = `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_git/${ADO_REPO}`;
const adoAuth = ADO_BEARER
  ? 'Bearer ' + ADO_BEARER
  : 'Basic ' + Buffer.from(':' + ADO_PAT).toString('base64');

async function ado(path, params = {}) {
  const u = new URL(ADO_BASE + path);
  u.searchParams.set('api-version', '7.1');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: adoAuth } });
  if (!r.ok) throw new Error(`ADO ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

// ---- read ADO ----------------------------------------------------------------
async function repoId() { return (await ado('')).id; }

async function pullRequests() {
  const out = [];
  for (const status of ['active', 'completed']) {
    // completed: only the last COMPLETED_DAYS; active: all
    const list = await ado('/pullrequests', {
      'searchCriteria.status': status,
      '$top': status === 'active' ? '200' : '100',
    });
    const cutoff = Date.now() - Number(COMPLETED_DAYS) * 864e5;
    for (const pr of list.value) {
      const closed = pr.closedDate ? Date.parse(pr.closedDate) : Date.now();
      if (status === 'completed' && closed < cutoff) continue;
      out.push(pr);
    }
  }
  return out;
}

async function branches() {
  const refs = await ado('/refs', { filter: 'heads' });
  // skip protected/env branches — they carry no single DP key
  const skip = new Set(['develop', 'main', 'release/QA', 'release/UAT']);
  return refs.value
    .map((r) => ({ name: r.name.replace('refs/heads/', ''), objectId: r.objectId }))
    .filter((b) => !skip.has(b.name));
}

async function tipCommit(objectId) {
  const c = await ado(`/commits/${objectId}`);
  return {
    id: c.commitId,
    displayId: c.commitId.slice(0, 7),
    message: clip(c.comment),
    author: c.author?.name || 'unknown',
    authorTimestamp: c.author?.date || new Date(0).toISOString(),
    url: `${ADO_WEB}/commit/${c.commitId}`,
    changeCounts: c.changeCounts,
  };
}

// ---- build DevInfo payload ---------------------------------------------------
const ADO_PR_STATUS = { active: 'OPEN', completed: 'MERGED', abandoned: 'DECLINED' };

async function build(rid) {
  const prs = await pullRequests();
  const brs = await branches();

  const commits = [];
  const branchEntities = [];
  const seenCommit = new Set();

  for (const b of brs) {
    const keys = keysFrom(b.name);
    if (!keys.length) continue;
    const tip = await tipCommit(b.objectId);
    const tipKeys = keysFrom(tip.message).length ? keysFrom(tip.message) : keys;
    if (!seenCommit.has(tip.id)) {
      seenCommit.add(tip.id);
      commits.push({
        id: tip.id, displayId: tip.displayId, issueKeys: tipKeys,
        message: tip.message, url: tip.url,
        author: { name: tip.author }, authorTimestamp: tip.authorTimestamp,
        fileCount: (tip.changeCounts?.Add || 0) + (tip.changeCounts?.Edit || 0) + (tip.changeCounts?.Delete || 0),
        updateSequenceId: seq(tip.authorTimestamp),
      });
    }
    branchEntities.push({
      id: branchId(b.name), name: b.name, issueKeys: keys,
      url: `${ADO_WEB}?version=GB${encodeURIComponent(b.name)}`,
      lastCommit: {
        id: tip.id, displayId: tip.displayId, issueKeys: tipKeys,
        message: tip.message, url: tip.url,
        author: { name: tip.author }, authorTimestamp: tip.authorTimestamp,
        fileCount: (tip.changeCounts?.Add || 0) + (tip.changeCounts?.Edit || 0) + (tip.changeCounts?.Delete || 0),
        updateSequenceId: seq(tip.authorTimestamp),
      },
      updateSequenceId: seq(tip.authorTimestamp),
    });
  }

  const pullRequestEntities = [];
  for (const pr of prs) {
    const src = (pr.sourceRefName || '').replace('refs/heads/', '');
    const tgt = (pr.targetRefName || '').replace('refs/heads/', '');
    // Authoritative keys only: branch name + PR title. NOT the description —
    // descriptions are prose that name-drop other tickets ("relates to DP-19"),
    // which over-links a PR to issues it doesn't own.
    const keys = keysFrom(src, pr.title);
    if (!keys.length) continue;
    const updated = pr.closedDate || pr.creationDate || new Date().toISOString();
    pullRequestEntities.push({
      id: String(pr.pullRequestId),
      issueKeys: keys,
      status: ADO_PR_STATUS[pr.status] || 'OPEN',
      title: clip(pr.title),
      displayId: `#${pr.pullRequestId}`,
      commentCount: 0,
      author: { name: pr.createdBy?.displayName || 'unknown' },
      sourceBranch: src, destinationBranch: tgt,
      url: `${ADO_WEB}/pullrequest/${pr.pullRequestId}`,
      lastUpdate: updated,
      updateSequenceId: seq(updated),
    });
  }

  return {
    repositories: [{
      id: rid, name: ADO_REPO, url: ADO_WEB,
      commits, branches: branchEntities, pullRequests: pullRequestEntities,
      updateSequenceId: Date.parse(new Date().toISOString()),
    }],
    properties: { installationId: 'ado-devinfo-sync' },
    providerMetadata: { product: 'Azure DevOps' },
  };
}

// ---- Jira -------------------------------------------------------------------
async function jiraToken() {
  const r = await fetch('https://api.atlassian.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: JIRA_CLIENT_ID, client_secret: JIRA_CLIENT_SECRET }),
  });
  if (!r.ok) throw new Error(`Jira token -> ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function pushDevInfo(token, payload) {
  const r = await fetch(`https://api.atlassian.com/jira/devinfo/0.1/cloud/${JIRA_CLOUD_ID}/bulk`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await r.text();
  if (r.status !== 202) throw new Error(`DevInfo push -> ${r.status} ${body}`);
  return JSON.parse(body);
}

// ---- main -------------------------------------------------------------------
(async () => {
  const rid = await repoId();
  const payload = await build(rid);
  const repo = payload.repositories[0];
  console.log(`built: ${repo.pullRequests.length} PRs, ${repo.branches.length} branches, ${repo.commits.length} commits (with DP-<n>)`);

  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2));
    console.log('DRY_RUN — not pushing.');
    return;
  }
  const token = await jiraToken();
  const res = await pushDevInfo(token, payload);
  const acc = res.acceptedDevinfoEntities?.[rid] || {};
  console.log(`accepted: ${acc.pullRequests?.length || 0} PRs, ${acc.branches?.length || 0} branches, ${acc.commits?.length || 0} commits`);
  if (res.unknownIssueKeys?.length) console.log(`unknownIssueKeys: ${res.unknownIssueKeys.join(', ')}`);
  if (Object.keys(res.failedDevinfoEntities || {}).length) {
    console.error('FAILED:', JSON.stringify(res.failedDevinfoEntities));
    process.exit(1);
  }
  console.log('done.');
})().catch((e) => { console.error(e.message); process.exit(1); });
