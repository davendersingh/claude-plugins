// crucible-pipeline — accelerator engine for the crucible plugin.
//
// Two modes (selected via args.mode):
//   - "sprint":      fan a manifest's items out across the dependency DAG; each item runs its own
//                    RED→GREEN→review→QA loop via the isolated role subagents, stacking child branches.
//   - "deep-review": adversarial review PANEL — N independent skeptics try to REFUTE each finding;
//                    only findings that survive a majority refute-vote are returned.
//
// The single-feature flow is command-driven (commands/crucible.md); this engine is invoked by that
// command for sprint mode and for `--deep-review`. Role subagents resolve via the installed plugin
// (agentType "crucible:senior" | "crucible:reviewer" | "crucible:tester").
//
// Workflow-script constraints honored: plain JS (no TS), no Date.now()/Math.random()/new Date().

export const meta = {
  name: 'crucible-pipeline',
  description: 'crucible accelerator: sprint DAG fan-out (per-item RED→GREEN→review→QA with isolated role subagents) and adversarial deep-review panel (majority refute-vote).',
  phases: [
    { title: 'Sprint' },
    { title: 'DeepReview' },
  ],
}

// ---------- schemas (kept lenient to minimise subagent retries) ----------
const IMPL_SCHEMA = {
  type: 'object', additionalProperties: true,
  required: ['branch', 'headSha', 'baseSha', 'status'],
  properties: {
    branch: { type: 'string' },
    worktree: { type: 'string' },
    baseSha: { type: 'string' },
    headSha: { type: 'string' },
    status: { type: 'string', description: 'implemented | blocked | needs-human' },
    commits: { type: 'array', items: { type: 'string' } },
    redGreenEvidence: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: true,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', description: 'APPROVED | CHANGES_REQUESTED' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: true,
        required: ['id', 'severity', 'confidence', 'what'],
        properties: {
          id: { type: 'string' }, severity: { type: 'string' },
          confidence: { type: 'number' }, location: { type: 'string' },
          what: { type: 'string' }, why: { type: 'string' }, fix: { type: 'string' },
        },
      },
    },
  },
}
const QA_SCHEMA = {
  type: 'object', additionalProperties: true,
  required: ['result', 'bugs'],
  properties: {
    result: { type: 'string', description: 'QA-PASS | QA-FAIL' },
    testStory: { type: 'string' },
    acChecklist: { type: 'array', items: { type: 'string' } },
    bugs: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: true,
        required: ['id', 'severity', 'repro'],
        properties: {
          id: { type: 'string' }, severity: { type: 'string' },
          repro: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' },
        },
      },
    },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['real', 'reason'],
  properties: {
    real: { type: 'boolean', description: 'true only if this is a genuine, spec-relevant issue' },
    reason: { type: 'string' },
  },
}

const A = (typeof args !== 'undefined' && args) ? args : {}
const MODE = A.mode || 'sprint'
const BASE = A.base || 'main'
const FIX_ROUNDS = A.fixRounds || 3
const PANEL = A.panel || 3

// ====================================================================== SPRINT
async function runSprint() {
  phase('Sprint')
  const items = Array.isArray(A.items) ? A.items : []
  if (!items.length) return { mode: 'sprint', error: 'no items provided in args.items' }

  const byId = {}
  items.forEach((i) => { byId[i.id] = i })

  // Group into dependency levels (topological). Items in a level are independent.
  const levels = []
  const done = new Set()
  let remaining = items.slice()
  let guard = 0
  while (remaining.length && guard < 1000) {
    guard++
    const ready = remaining.filter((i) =>
      (i.depends_on || []).every((d) => done.has(d) || !byId[d]))
    if (!ready.length) { levels.push(remaining); break } // cycle / missing dep → run the rest as-is
    levels.push(ready)
    ready.forEach((i) => done.add(i.id))
    remaining = remaining.filter((i) => !done.has(i.id))
  }

  const results = []
  const branchById = {}
  const CONCURRENCY = (A.concurrency && A.concurrency > 0) ? A.concurrency : 0 // 0 = unbounded (runtime caps)
  for (let li = 0; li < levels.length; li++) {
    const level = levels[li]
    log(`sprint level ${li + 1}/${levels.length}: ${level.map((i) => i.id).join(', ')}`)
    const groups = CONCURRENCY > 0 ? chunk(level, CONCURRENCY) : [level]
    for (let gi = 0; gi < groups.length; gi++) {
      const levelResults = await parallel(groups[gi].map((item) => () => {
        const parentBranches = (item.depends_on || []).map((d) => branchById[d]).filter(Boolean)
        return runItem(item, parentBranches)
      }))
      levelResults.filter(Boolean).forEach((r) => {
        results.push(r)
        // Only register a branch as a stackable parent if the item actually produced one — a
        // 'failed' item carries a *computed* branch name that the senior never created.
        if (r.branch && r.status !== 'failed') branchById[r.item] = r.branch
      })
    }
  }
  return { mode: 'sprint', base: BASE, results }
}

function chunk(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

async function runItem(item, parentBranches) {
  const parent = parentBranches && parentBranches.length ? parentBranches[0] : BASE
  const branch = item.branch || `${A.branchPrefix || 'feat'}/${item.id}-${item.slug || ''}`.replace(/-$/, '')

  // 1. Senior: create worktree+branch stacked on parent, implement RED→GREEN, commit per task.
  const impl = await agent(seniorImplementPrompt(item, branch, parent),
    { agentType: 'crucible:senior', label: `senior:${item.id}`, phase: 'Sprint', schema: IMPL_SCHEMA })
  if (!impl || !impl.headSha || impl.status === 'blocked') {
    return { item: item.id, branch, status: 'failed', stage: 'implement', impl: impl || null }
  }

  // 2. Review + QA loop — independent, isolated; fix blockers; re-verify on fresh evidence.
  let round = 0
  let review = null
  let qa = null
  let head = impl.headSha
  while (round < FIX_ROUNDS) {
    const pair = await parallel([
      () => agent(reviewerPrompt(item, impl, head),
        { agentType: 'crucible:reviewer', label: `review:${item.id}:r${round}`, phase: 'Sprint', schema: REVIEW_SCHEMA }),
      () => agent(testerPrompt(item, impl, head),
        { agentType: 'crucible:tester', label: `qa:${item.id}:r${round}`, phase: 'Sprint', schema: QA_SCHEMA }),
    ])
    review = pair[0]
    qa = pair[1]
    const blockers = []
    if (review && Array.isArray(review.findings)) {
      review.findings.filter((f) => f.severity === 'Critical' || f.severity === 'Important').forEach((f) => blockers.push(f))
    }
    // Symmetric with the review gate: only Critical/Important bugs block; Minor bugs are recorded
    // (carried on `qa`) for the Manager to file to backlog, not looped on.
    if (qa && Array.isArray(qa.bugs)) {
      qa.bugs.filter((b) => b.severity === 'Critical' || b.severity === 'Important').forEach((b) => blockers.push(b))
    }
    if (!blockers.length) {
      return { item: item.id, branch: impl.branch || branch, baseSha: impl.baseSha, headSha: head, status: 'verified', review, qa, rounds: round + 1 }
    }
    // 3. Senior fixes the blockers (one isolated pass), then we re-verify.
    const fix = await agent(seniorFixPrompt(item, impl, head, blockers),
      { agentType: 'crucible:senior', label: `fix:${item.id}:r${round}`, phase: 'Sprint', schema: IMPL_SCHEMA })
    if (!fix || !fix.headSha) {
      // No new commit — re-verifying the identical diff would just burn the remaining rounds.
      return { item: item.id, branch: impl.branch || branch, baseSha: impl.baseSha, headSha: head, status: 'needs-human', review, qa, rounds: round + 1, note: 'fix pass produced no new commit' }
    }
    head = fix.headSha
    round++
  }
  return { item: item.id, branch: impl.branch || branch, baseSha: impl.baseSha, headSha: head, status: 'needs-human', review, qa, rounds: round }
}

// ================================================================= DEEP REVIEW
async function runDeepReview() {
  phase('DeepReview')
  let findings = Array.isArray(A.findings) ? A.findings : null
  if (!findings) {
    const gen = await agent(reviewGenPrompt(),
      { agentType: 'crucible:reviewer', label: 'review:gen', phase: 'DeepReview', schema: REVIEW_SCHEMA })
    findings = (gen && gen.findings) || []
  }
  if (!findings.length) return { mode: 'deep-review', findings: [], note: 'no findings to verify' }

  const verified = await parallel(findings.map((f, fi) => () =>
    parallel(Array.from({ length: PANEL }, (_, k) => () =>
      agent(refutePrompt(f, fi, k),
        { agentType: 'crucible:reviewer', label: `refute:${f.id || fi}:${k}`, phase: 'DeepReview', schema: VERDICT_SCHEMA })))
      .then((votes) => {
        const real = votes.filter(Boolean).filter((v) => v.real).length
        return { finding: f, real, panel: PANEL, survives: real * 2 > PANEL }
      })))

  const survivors = verified.filter(Boolean).filter((v) => v.survives)
    .map((v) => Object.assign({}, v.finding, { votes: `${v.real}/${v.panel}` }))
  return { mode: 'deep-review', base: A.base, head: A.head, panel: PANEL, findings: survivors, considered: findings.length }
}

// ----------------------------------------------------------------- prompts
function specBlock() {
  return [
    A.specPath ? `Design spec: ${A.specPath}` : '',
    A.acPath ? `Story (acceptance criteria): ${A.acPath}` : '',
  ].filter(Boolean).join('\n')
}

function seniorImplementPrompt(item, branch, parent) {
  return `SPRINT ITEM ${item.id}. Follow your crucible:senior discipline (spec-first RED→GREEN→REFACTOR, per task).

Story file: ${item.storyPath}
Plan file (if present): ${item.planPath || '(write it first)'}
Branch to create: ${branch}   (stack it on the tip of: ${parent})
Repo base: ${BASE}

Steps:
1. Create an isolated worktree + branch: from ${parent}'s current tip, \`git worktree add .worktrees/crucible-${item.id}-${item.slug || 'item'} -b ${branch} ${parent}\`. Work there.
2. Read the story + design spec and the repo's own conventions (CLAUDE.md / AGENTS.md / rules). Write/confirm the plan.
3. Execute task-by-task: failing spec FIRST → prove RED → minimal impl → prove GREEN → refactor → commit. Use the repo's resolved validation commands (crucible.config.json or auto-detected). If a target's tests are disabled in CI, your local run is the only safety net.
Return: branch, worktree path, baseSha (merge-base with ${BASE}), headSha (tip), commit SHAs, redGreenEvidence (command → decisive line per task), status.`
}

function seniorFixPrompt(item, impl, head, blockers) {
  return `SPRINT ITEM ${item.id} — fix pass. Work in worktree ${impl.worktree || '(your branch ' + impl.branch + ')'} on branch ${impl.branch}. Current tip: ${head}.
Fix ONLY these blocking findings/bugs, one at a time, each with a regression-guarding test, keeping all specs green:
${JSON.stringify(blockers, null, 2)}
Re-run the touched targets' suites to prove green. Return updated headSha + commit SHAs + evidence. Budget: 3 attempts per finding; if one won't resolve, report it as needs-human rather than guessing.`
}

// Reviewer/Tester inputs are ARTIFACTS ONLY (diff + spec/AC). No senior narrative is passed in.
function reviewerPrompt(item, impl, head) {
  return `Independent code review for sprint item ${item.id}. You have NOT seen how this was built.
Get the diff yourself: \`git -C ${impl.worktree || '.'} diff ${impl.baseSha}..${head}\` (also read changed files).
${specBlock() || `Story: ${item.storyPath}`}
Map each acceptance criterion to evidence in the diff; hunt real bugs (logic, null/undefined, races, missing error handling, silent failures, security) and violations of the repo's own conventions (read its CLAUDE.md / AGENTS.md / rules / linter config). Report confidence-scored findings (≥50) by severity, or APPROVED.`
}

function testerPrompt(item, impl, head) {
  return `Independent QA for sprint item ${item.id}. You have NOT seen the implementer's reasoning or any review verdict.
Diff: \`git -C ${impl.worktree || '.'} diff ${impl.baseSha}..${head}\`.
Story (acceptance criteria): ${item.storyPath}.
Write a test-story under the repo's artifacts dir, run the full suite for every touched target (the repo's resolved validation commands; include any suite disabled in CI — it is the only safety net), probe adversarial edges, verify each AC against observed behavior. File bugs with repro, or QA-PASS. Close bugs only on fresh passing evidence.`
}

function reviewGenPrompt() {
  return `Independent code review. You have NOT seen how this was built.
Diff: \`git diff ${A.base}..${A.head}\` (read changed files as needed).
${specBlock()}
Report confidence-scored findings (≥50) by severity. This list will be adversarially re-verified, so be precise — no padding.`
}

function refutePrompt(f, fi, k) {
  return `You are independent skeptic #${k + 1} on a review panel. A colleague claims the following finding about a code change vs its spec. Your job is to REFUTE it. Default to real=false unless, after checking the diff and spec yourself, you confirm it is a genuine, spec-relevant issue that will bite in practice.
Diff: \`git diff ${A.base}..${A.head}\`.
${specBlock()}
Claimed finding:
${JSON.stringify(f, null, 2)}
Verify against the actual code. Return real (boolean) + a one-sentence reason.`
}

// --------------------------------------------------------------- dispatch
if (MODE === 'sprint') {
  return await runSprint()
} else if (MODE === 'deep-review') {
  return await runDeepReview()
}
return { error: `unknown mode: ${MODE}` }
