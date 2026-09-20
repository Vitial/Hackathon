// Vital approval answerer: a dsh Cordis plugin enforcing the frozen policy
// snapshot inside the runtime process.
//
// Mounted per-run via a generated --patch overlay (see policy-plugin.ts).
// Answers `approval/request` from the snapshot file
// `<dir>/vital-policy-<sessionId>.json` (dir = VITAL_POLICY_DIR, else the OS
// temp dir); the session id comes from the request's own agent, so no
// per-run channel (env, config) is needed and concurrent runtimes cannot
// collide.
//
// Verdicts mirror the governed policy's deterministic core:
//   kill-at-start            -> rejected (the run should never have started)
//   READ tools               -> allowed-once
//   ACT_REVERSIBLE tools     -> allowed-once iff a verified human approval is
//                               bound in the snapshot, else rejected
//   ACT_IRREVERSIBLE tools   -> rejected (agents may not self-approve)
//   unknown tools            -> next(): delegate; downstream fails closed and
//                               the parent runner denies by default.
//
// Limits (parent-enforced, not here): mid-turn kill switches, budget
// ceilings, and shell-argument screening — the approval request carries no
// tool arguments, so arg screening stays in DshRunner. Divergence resolves
// fail-closed: this vetoes per-call, the parent kills the turn.
//
// Plain JS, zero dependencies: loads directly, no build step. Plain Node
// APIs only (node:fs, node:os, node:path).
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const name = 'vital-approval';
export const inject = ['approval'];

function snapshotDir() {
  return process.env.VITAL_POLICY_DIR ?? tmpdir();
}

function snapshotPathFor(sessionId) {
  const safe = String(sessionId ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(snapshotDir(), `vital-policy-${safe}.json`);
}

function loadSnapshot(sessionId) {
  try {
    const raw = readFileSync(snapshotPathFor(sessionId), 'utf8');
    const snap = JSON.parse(raw);
    if (!snap || snap.version !== 1 || typeof snap.tools !== 'object') return null;
    return snap;
  } catch {
    return null;
  }
}

export function decide(snapshot, toolName) {
  if (!snapshot) return 'delegate';
  if (snapshot.killAtStart) return 'rejected';
  const cls = snapshot.tools?.[toolName];
  if (cls === 'READ') return 'allowed-once';
  if (cls === 'ACT_REVERSIBLE') return snapshot.approvedDecisionId ? 'allowed-once' : 'rejected';
  if (cls === 'ACT_IRREVERSIBLE') return 'rejected';
  return 'delegate';
}

export function apply(ctx) {
  ctx.on('approval/request', (request, next) => {
    const sessionId = request?.agent?.session?.id;
    const snap = sessionId ? loadSnapshot(sessionId) : null;
    if (!snap) return next();
    const verdict = decide(snap, request.toolName);
    if (verdict === 'delegate') return next();
    return verdict;
  });
}
