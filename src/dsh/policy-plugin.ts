import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { AsyncDb } from '../core/db.ts';
import {
  buildPolicySnapshot,
  makePolicyRunDir,
  policySnapshotDir,
  removePolicySnapshot,
  writePolicySnapshot,
} from './policy-snapshot.ts';

/**
 * Per-run wiring for the in-runtime approval answerer
 * (src/dsh/vital-approval.mjs).
 *
 * The patch overlay must carry ABSOLUTE paths (plugin module + nothing else
 * variable), so it is generated per run into a temp dir alongside the policy
 * snapshot. The plugin itself needs no channel: it derives the snapshot path
 * from the approval request's session id.
 *
 * Opt-in via DSH_POLICY_PLUGIN=1 until a live-model turn verifies decision
 * behavior end to end (mount + handshake are verified; see
 * scripts/live-dsh-hello.ts DSH_VERIFY_PLUGIN=1). The parent-side gate in
 * DshRunner stays authoritative regardless.
 */

export interface PolicyEnforcement {
  /** Directory holding the snapshot + patch (remove when done). */
  dir: string;
  /** Absolute snapshot path (for the runner's own bookkeeping). */
  snapshotPath: string;
  /** Absolute patch path to append as `--patch`. */
  patchPath: string;
  cleanup(): void;
}

const yamlSingleQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export function buildPolicyPatch(pluginPath: string): string {
  return (
    `# Generated per run by DshRunner (src/dsh/policy-plugin.ts); do not edit.\n` +
    `# Mounts the Vital approval answerer onto the sdk profile's approval\n` +
    `# service. The snapshot path needs no channel: the plugin derives it\n` +
    `# from each approval request's session id.\n` +
    `- insert:\n` +
    `    - id: vital-approval\n` +
    `      name: ${yamlSingleQuote(pluginPath)}\n` +
    `      inject: [approval]\n`
  );
}

export function vitalApprovalPluginPath(): string {
  return fileURLToPath(new URL('./vital-approval.mjs', import.meta.url));
}

export async function preparePolicyEnforcement(
  db: AsyncDb,
  tenant: string,
  scope: string,
  sessionId: string,
  approvedDecisionId?: string,
  dir = policySnapshotDir(),
): Promise<PolicyEnforcement> {
  const runDir = makePolicyRunDir();
  const snapshot = await buildPolicySnapshot(db, tenant, scope, sessionId, approvedDecisionId);
  // The snapshot MUST live where the plugin looks: the shared policy dir,
  // not the per-run dir (the plugin derives dir + per-session filename).
  const snapshotPath = writePolicySnapshot(dir, snapshot);
  const patchPath = join(runDir, 'vital-approval.patch.yml');
  writeFileSync(patchPath, buildPolicyPatch(vitalApprovalPluginPath()), 'utf8');
  return {
    dir: runDir,
    snapshotPath,
    patchPath,
    cleanup: () => {
      removePolicySnapshot(snapshotPath);
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}

export function policyPluginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DSH_POLICY_PLUGIN === '1';
}
