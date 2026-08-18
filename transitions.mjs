#!/usr/bin/env node
// ADO -> Jira auto-transition. No deps (Node 20+ global fetch).
//
// Companion to sync.mjs. Reads the same Azure DevOps state (branches, PRs) and
// moves each DP-<n> issue's status FORWARD along the "DP Delivery Workflow" to
// reflect where the work actually is:
//
//   branch exists / >=1 commit  -> In Development        (10113)
//   PR open                     -> PR Raised             (10114)
//   PR approved (reviewer vote) -> PR Reviewed           (10115)
//   PR merged to develop        -> Development Complete  (10116)
//
// SAFETY:
//   * Forward-only. Never regresses a ticket. If the issue's current status is
//     already at or beyond the target's pipeline rank, it is left untouched —
//     manual advances (Ready to Deploy / In Testing / …) always win.
//   * Idempotent. A transition (and its comment) fires only when the status
//     actually changes, so re-running every minute does not spam.
//   * Multi-step. If a ticket is several stages behind the target (missed
//     intermediate events), it is walked up one valid transition at a time.
//   * Each move is stamped with historyMetadata ("Automated by ADO<->Jira Sync")
//     and a comment naming the trigger, so the activity log shows it was auto.
//
// Env:
//   JIRA_USER_EMAIL, JIRA_API_TOKEN   (Jira basic auth — a user API token with
//                                      transition rights on project DP)
//   JIRA_SITE        default "fashionuk.atlassian.net"
//   ADO_PAT | ADO_BEARER, ADO_ORG, ADO_PROJECT, ADO_REPO   (as sync.mjs)
//   COMPLETED_DAYS   default 30
//   DRY_RUN          "1" to log intended transitions without applying

const {
  JIRA_USER_EMAIL, JIRA_API_TOKEN,
  JIRA_SITE = 'fashionuk.atlassian.net',
  ADO_PAT, ADO_BEARER,
  ADO_ORG = 'fashion-uk',
  ADO_PROJECT = 'Design_Portal',
  ADO_REPO = 'Design_Portal',
  COMPLETED_DAYS = '30',
  DRY_RUN = '',
} = process.env;

for (const [k, v] of Object.entries({ JIRA_USER_EMAIL, JIRA_API_TOKEN })) {
  if (!v) { console.error(`missing env: ${k}`); process.exit(1); }
}
if (!ADO_PAT && !ADO_BEARER) { console.error('missing env: ADO_PAT (or ADO_BEARER)'); process.exit(1); }

// ---- workflow model ---------------------------------------------------------
// Pipeline rank: automation only moves a ticket to a HIGHER rank than it holds.
// Statuses past "Development Complete" get high ranks so the guard never touches
// a ticket already in the QA/UAT/Prod tail.
const STATUS = {
  '10036': { name: 'To Do', rank: 0 },
  '10112': { name: 'Under Investigation', rank: 0 },
  '10113': { name: 'In Development', rank: 1 },
  '10114': { name: 'PR Raised', rank: 2 },
  '10115': { name: 'PR Reviewed', rank: 3 },
  '10116': { name: 'Development Complete', rank: 4 },
  // tail (never set by automation; only used to cap the guard)
  '10117': { name: 'Ready to Deploy to QA', rank: 5 },
  '10118': { name: 'Ready for QA (Deployed)', rank: 6 },
  '10119': { name: 'In Testing', rank: 7 },
  '10120': { name: 'Failed Testing', rank: 7 },
  '10121': { name: 'Passed Testing', rank: 8 },
  '10122': { name: 'Ready to Deploy to UAT', rank: 9 },
  '10123': { name: 'Deployed on UAT', rank: 10 },
  '10127': { name: 'UAT Rejected', rank: 10 },
  '10124': { name: 'Ready to Deploy to Prod', rank: 11 },
  '10125': { name: 'Deployed on Prod', rank: 12 },
  '10037': { name: 'Done', rank: 13 },
  '6': { name: 'Closed', rank: 13 },
  '10126': { name: "Won't Do", rank: 13 },
};
// The ordered dev-stage chain automation drives (rank 1..4). Walking up follows this.
const CHAIN = ['10113', '10114', '10115', '10116'];

const DP_RE = /\bDP-\d+\b/gi;
const keysFrom = (...strs) => {
  const set = new Set();
  for (const s of strs) for (const m of String(s || '').matchAll(DP_RE)) set.add(m[0].toUpperCase());
  return [...set];
};

// ---- ADO --------------------------------------------------------------------
const ADO_BASE = `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_apis/git/repositories/${ADO_REPO}`;
const adoAuth = ADO_BEARER ? 'Bearer ' + ADO_BEARER
  : 'Basic ' + Buffer.from(':' + ADO_PAT).toString('base64');

async function ado(path, params = {}) {
  const u = new URL(ADO_BASE + path);
  u.searchParams.set('api-version', '7.1');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: adoAuth } });
  if (!r.ok) throw new Error(`ADO ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

// Compute, per DP key, the FURTHEST dev stage its ADO state justifies + why.
async function desiredStages() {
  const want = new Map(); // key -> { targetId, reason, at }
  // `at` is when the evidence for this stage appeared (ms epoch, or null if the
  // API gives us no timestamp). The manual-override floor uses it to tell a NEW
  // event from the stale one a human already rejected — see manualFloorFrom().
  const bump = (key, targetId, reason, at = null) => {
    const cur = want.get(key);
    if (!cur || STATUS[targetId].rank > STATUS[cur.targetId].rank) want.set(key, { targetId, reason, at });
  };

  // branches -> In Development
  const refs = await ado('/refs', { filter: 'heads' });
  const skip = new Set(['develop', 'main', 'release/QA', 'release/UAT']);
  for (const r of refs.value) {
    const name = r.name.replace('refs/heads/', '');
    if (skip.has(name)) continue;
    // A ref carries no creation date in this API response, so `at` stays null —
    // treated as "not provably new", which is the safe side of the floor check.
    for (const key of keysFrom(name)) bump(key, '10113', `branch \`${name}\` exists`, null);
  }

  // PRs -> Raised / Reviewed / Development Complete
  const cutoff = Date.now() - Number(COMPLETED_DAYS) * 864e5;
  for (const status of ['active', 'completed']) {
    const list = await ado('/pullrequests', {
      'searchCriteria.status': status, '$top': status === 'active' ? '200' : '100',
    });
    for (const pr of list.value) {
      if (status === 'completed') {
        const closed = pr.closedDate ? Date.parse(pr.closedDate) : Date.now();
        if (closed < cutoff) continue;
      }
      const src = (pr.sourceRefName || '').replace('refs/heads/', '');
      const keys = keysFrom(src, pr.title);
      if (!keys.length) continue;
      const tgt = (pr.targetRefName || '').replace('refs/heads/', '');
      let targetId, reason, at;
      if (pr.status === 'completed' && tgt === 'develop') {
        targetId = '10116'; reason = `PR #${pr.pullRequestId} merged to develop`;
        at = pr.closedDate ? Date.parse(pr.closedDate) : null;
      } else if (pr.status === 'active') {
        const votes = (pr.reviewers || []).map((v) => v.vote);
        const rejected = votes.some((v) => v < 0);
        const approved = votes.some((v) => v >= 10);
        // An approval has no timestamp of its own here; fall back to the PR's
        // creation date, which is necessarily older — again the safe side.
        at = pr.creationDate ? Date.parse(pr.creationDate) : null;
        if (approved && !rejected) { targetId = '10115'; reason = `PR #${pr.pullRequestId} approved`; }
        else { targetId = '10114'; reason = `PR #${pr.pullRequestId} open`; }
      } else {
        continue; // abandoned / completed-to-non-develop: leave to manual
      }
      for (const key of keys) bump(key, targetId, reason, at);
    }
  }
  return want;
}

// ---- Jira -------------------------------------------------------------------
const jiraAuth = 'Basic ' + Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
const JIRA = `https://${JIRA_SITE}/rest/api/3`;

async function jira(path, init = {}) {
  const r = await fetch(JIRA + path, {
    ...init,
    headers: { Authorization: jiraAuth, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`Jira ${init.method || 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function issueMeta(key) {
  const d = await jira(`/issue/${key}?fields=status,issuetype&expand=changelog`);
  return {
    statusId: d.fields.status.id,
    type: d.fields.issuetype?.name,
    manualFloor: manualFloorFrom(d.changelog),
  };
}

// ---- manual-override memory -------------------------------------------------
//
// The never-regress rank guard is not enough on its own. It asks "is the target
// higher than where the issue is now?" — and nothing records WHY the issue is
// where it is. So a human who moves a wrongly-advanced ticket back to To Do is
// silently undone: the next run re-reads the same merged PR, sees To Do (rank 0)
// below Development Complete (rank 4), and advances it again. Every ~5 minutes,
// forever. (Observed on DP-169/DP-170, which a *docs* PR marked Development
// Complete; resetting them by hand did not stick.)
//
// The fix reads Jira's own changelog rather than keeping external state. Our
// transitions are stamped `historyMetadata.type = 'ado-jira-sync'`, so an
// automated move is distinguishable from a human one. If a PERSON most recently
// moved the issue DOWN the pipeline, that lower rank becomes a floor: automation
// will not re-advance past it on evidence that already existed. Only a genuinely
// NEW event — one that first appeared after the manual reset — may move it again.
//
// "New" is decided by timestamp: an event is fresh only if it happened after the
// manual move. A PR merged last Tuesday cannot re-advance a ticket a human reset
// this morning; a PR merged this afternoon can.
function manualFloorFrom(changelog) {
  const histories = changelog?.histories || [];
  let latest = null;
  for (const h of histories) {
    const item = (h.items || []).find((i) => i.field === 'status');
    if (!item) continue;
    // Our own moves carry the sync's history metadata; anything else is a human.
    const automated = h.historyMetadata?.type === 'ado-jira-sync';
    if (automated) continue;
    const at = Date.parse(h.created);
    if (!latest || at > latest.at) {
      latest = { at, fromId: item.from, toId: item.to };
    }
  }
  if (!latest) return null;
  const fromRank = STATUS[latest.fromId]?.rank ?? -1;
  const toRank = STATUS[latest.toId]?.rank ?? -1;
  // Only a DOWNWARD human move creates a floor. A human advancing a ticket
  // forward is not an override of automation — it is agreement with it.
  if (toRank >= fromRank) return null;
  return { at: latest.at, rank: toRank, statusId: latest.toId };
}

// Find the transition whose destination is toStatusId, from the current status.
async function transitionIdTo(key, toStatusId) {
  const d = await jira(`/issue/${key}/transitions`);
  const t = d.transitions.find((x) => x.to.id === toStatusId);
  return t ? t.id : null;
}

// Apply a single transition (stamped as automated). No comment here — the comment
// is posted once per run, on the landing status (see the walk in main).
async function stepTransition(key, transitionId) {
  await jira(`/issue/${key}/transitions`, {
    method: 'POST',
    body: JSON.stringify({
      transition: { id: transitionId },
      historyMetadata: {
        type: 'ado-jira-sync',
        description: 'Automated by ADO↔Jira Sync',
        activityDescription: 'Auto-transition on Azure DevOps event',
      },
    }),
  });
}

async function postComment(key, fromName, toName, reason) {
  await jira(`/issue/${key}/comment`, {
    method: 'POST',
    body: JSON.stringify({
      body: {
        type: 'doc', version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text',
          text: `🤖 Auto-advanced ${fromName} → ${toName}. Trigger: ${reason}. (ADO↔Jira Sync)` }] }],
      },
    }),
  });
}

// ---- main -------------------------------------------------------------------
(async () => {
  const want = await desiredStages();
  console.log(`evaluating ${want.size} DP issues with ADO activity…`);

  const plan = [];   // {key, from, to, reason, steps}
  const skipped = [];
  for (const [key, { targetId, reason, at }] of want) {
    let meta;
    try { meta = await issueMeta(key); }
    catch (e) { skipped.push(`${key}: cannot read (${e.message.split('->')[1]?.trim() || e.message})`); continue; }

    // Epics track many children — never auto-move them on a single PR/branch.
    if (meta.type === 'Epic') { skipped.push(`${key}: Epic — excluded from auto-transition`); continue; }

    const fromId = meta.statusId;
    const from = STATUS[fromId] || { name: `status ${fromId}`, rank: -1 };
    const to = STATUS[targetId];
    if (from.rank < 0) { skipped.push(`${key}: unknown current status ${fromId}`); continue; }
    if (from.rank >= to.rank) { skipped.push(`${key}: at ${from.name} (rank ${from.rank}) ≥ target ${to.name} — no regress`); continue; }

    // Manual-override floor: a human moved this issue DOWN the pipeline, so the
    // evidence that first advanced it has been explicitly rejected. Re-advancing
    // on that same evidence is what made a hand-reset ticket bounce back within
    // minutes. Only evidence that appeared AFTER the manual move may act.
    const floor = meta.manualFloor;
    if (floor && to.rank > floor.rank) {
      if (at == null) {
        skipped.push(`${key}: manually set to ${STATUS[floor.statusId]?.name || floor.statusId} — holding (evidence has no timestamp, cannot prove it is new)`);
        continue;
      }
      if (at <= floor.at) {
        const when = new Date(floor.at).toISOString().slice(0, 16).replace('T', ' ');
        skipped.push(`${key}: manually set to ${STATUS[floor.statusId]?.name || floor.statusId} at ${when} — holding (${reason} predates it)`);
        continue;
      }
      // Evidence is genuinely newer than the manual move: let it through.
    }

    // walk up the dev chain from just-after current rank to target
    const steps = CHAIN.filter((sid) => STATUS[sid].rank > from.rank && STATUS[sid].rank <= to.rank);
    plan.push({ key, fromId, from, targetId, to, reason, steps });
  }

  // report
  for (const p of plan) console.log(`WILL MOVE  ${p.key}: ${p.from.name} → ${p.to.name}   [${p.reason}]`);
  for (const s of skipped) console.log(`skip       ${s}`);
  console.log(`\n${plan.length} to transition, ${skipped.length} skipped.`);

  if (DRY_RUN) { console.log('DRY_RUN — nothing applied.'); return; }

  let done = 0;
  for (const p of plan) {
    let curId = p.fromId, curName = p.from.name;
    for (const stepId of p.steps) {
      const tid = await transitionIdTo(p.key, stepId);
      if (!tid) { console.error(`${p.key}: no transition ${curName} → ${STATUS[stepId].name} available — stopping walk`); break; }
      await stepTransition(p.key, tid);
      curId = stepId; curName = STATUS[stepId].name;
    }
    if (curId !== p.fromId) {
      // one comment per run, on the status actually reached (may be < target if a hop was unavailable)
      await postComment(p.key, p.from.name, curName, p.reason);
      if (curId === p.targetId) { done++; console.log(`moved ${p.key} → ${p.to.name}`); }
      else console.log(`partial ${p.key}: ${p.from.name} → ${curName} (target ${p.to.name} not reachable)`);
    }
  }
  console.log(`done. ${done}/${plan.length} fully transitioned.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
