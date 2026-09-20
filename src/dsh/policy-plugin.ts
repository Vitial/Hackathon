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

/**
 * The standard Vital patch: the in-runtime approval answerer plus the
 * governance preamble section. Mounted per run by DshRunner (both lanes);
 * opt out with DSH_NO_DEFAULT_PLUGINS=1.
 *
 * Never a `system-prompt` service-config row: patch config replaces the
 * profile's own persona, while section registration is purely additive.
 */
export function buildVitalPatch(approvalPluginPath: string, governancePluginPath: string): string {
  return (
    `# Generated per run by DshRunner (src/dsh/policy-plugin.ts); do not edit.\n` +
    `# Vital default plugins over the sdk profile: the approval answerer\n` +
    `# (snapshot path derived per request, no channel needed) and the\n` +
    `# governance preamble section.\n` +
    `- insert:\n` +
    `    - id: vital-approval\n` +
    `      name: ${yamlSingleQuote(approvalPluginPath)}\n` +
    `      inject: [approval]\n` +
    `    - id: vital-governance\n` +
    `      name: ${yamlSingleQuote(governancePluginPath)}\n` +
    `      inject: [systemPrompt]\n`
  );
}

export function vitalApprovalPluginPath(): string {
  return fileURLToPath(new URL('./vital-approval.mjs', import.meta.url));
}

export function vitalGovernancePluginPath(): string {
  return fileURLToPath(new URL('./vital-governance.mjs', import.meta.url));
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
  const patchPath = join(runDir, 'vital.patch.yml');
  writeFileSync(patchPath, buildVitalPatch(vitalApprovalPluginPath(), vitalGovernancePluginPath()), 'utf8');
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
  // Default plugins mount on every harnessed turn (mount + handshake
  // verified; approval decisions unit-tested; the parent gate stays
  // authoritative regardless). Opt out only to isolate a suspect plugin.
  if (env.DSH_NO_DEFAULT_PLUGINS === '1') return false;
  return true;
}
