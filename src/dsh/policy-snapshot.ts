import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AsyncDb } from '../core/db.ts';
import { checkKill } from '../gov/trust.ts';

/**
 * Policy snapshot: the deterministic core of Vital's governed permission
 * policy, frozen at run start for the in-runtime approval answerer
 * (src/dsh/vital-approval.mjs).
 *
 * Why a snapshot and not a live call: the answerer runs INSIDE the dsh
 * runtime process, and the SDK wire has no server→client channel to ask the
 * parent back. So the parent freezes what is knowable at run start; anything
 * dynamic (mid-turn kill switches, budget, arg screening) stays parent-side
 * in DshRunner, which aborts by closing the runtime. Divergence resolves
 * fail-closed: the plugin vetoes per-call, the parent kills the turn.
 *
 * Handoff is file-based and race-free: snapshots live in a fixed directory
 * (VITAL_POLICY_DIR, else the OS temp dir) under per-session filenames, and
 * the plugin derives the path from the approval request's own session id.
 * No per-run environment mutation, so concurrent runtimes cannot collide.
 */

export type DshActionClass = 'READ' | 'ACT_REVERSIBLE' | 'ACT_IRREVERSIBLE';

/** dsh SDK tool roster mapped onto Vital action classes. Unknown tools are
 *  absent: the plugin delegates (next()) and the parent denies by default. */
export const DSH_TOOL_CLASSES: Record<string, DshActionClass> = {
  read: 'READ',
  write: 'ACT_REVERSIBLE',
  edit: 'ACT_REVERSIBLE',
  bash: 'ACT_IRREVERSIBLE',
};

export interface PolicySnapshot {
  version: 1;
  sessionId: string;
  scope: string;
  /** dsh tool name -> action class. */
  tools: Record<string, DshActionClass>;
  /** Kill-switch state at run start. Mid-turn changes are parent-enforced. */
  killAtStart: boolean;
  /** Human approval binding the reversible class, when verified. */
  approvedDecisionId: string | null;
}

export function snapshotPathFor(dir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(dir, `vital-policy-${safe}.json`);
}

export function policySnapshotDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.VITAL_POLICY_DIR ?? tmpdir();
}

/**
 * Freeze the deterministic policy core for one run. Verifies the human
 * approval binding against the decisions table the same way the governed
 * policy does (approval/human-command autonomy by a human, scope-matched).
 */
export async function buildPolicySnapshot(
  db: AsyncDb,
  tenant: string,
  scope: string,
  sessionId: string,
  approvedDecisionId?: string,
): Promise<PolicySnapshot> {
  const killAtStart =
    (await checkKill(db, tenant, scope, '*')) ||
    (await checkKill(db, tenant, '*', '*')) ||
    (await checkKill(db, tenant, scope, 'ACT_REVERSIBLE'));
  let approved: string | null = null;
  if (approvedDecisionId) {
    const dec = (await db.prepare('SELECT * FROM decisions WHERE tenant = ? AND id = ?').get(
      tenant,
      approvedDecisionId,
    )) as
      | { id: string; approved_by: string | null; autonomy: string; scope: string }
      | undefined;
    if (dec && dec.approved_by && (dec.autonomy === 'approval' || dec.autonomy === 'human-command')) {
      if (!scope || dec.scope === scope) approved = dec.id;
    }
  }
  return {
    version: 1,
    sessionId,
    scope,
    tools: { ...DSH_TOOL_CLASSES },
    killAtStart,
    approvedDecisionId: approved,
  };
}

export function writePolicySnapshot(dir: string, snapshot: PolicySnapshot): string {
  const path = snapshotPathFor(dir, snapshot.sessionId);
  writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf8');
  return path;
}

export function removePolicySnapshot(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort cleanup */
  }
}

/** Per-run temp dir for the snapshot + patch pair. Removed by the caller. */
export function makePolicyRunDir(): string {
  return mkdtempSync(join(tmpdir(), 'vital-dsh-policy-'));
}
