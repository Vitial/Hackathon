/**
 * Live-sibling probe (§0.6 gate, dsh edition): boot the REAL dsh SDK runtime
 * (`dsh --profile sdk` from the installed @deepseek-ai/dsh package), then run
 * OUR client against the real wire:
 *
 *   DshClient -> dsh --profile sdk (stdio JSON-RPC)
 *
 * Phases:
 *   1. `initialize` returns the wire-stable server identity
 *      (`deepseek-harness-sdk-runtime`). Boot + handshake make no model call,
 *      so no credentials are needed for this phase.
 *   2. Optional live turn: when DEEPSEEK_API_KEY is set, queue one trivial
 *      prompt ('say hi') on a fresh session and assert the run settles idle
 *      with a non-empty final response. Skipped (exit 0) without creds.
 *   3. `close()` tears the runtime down to quiescence (protocol `shutdown`
 *      + EOF → SIGTERM → SIGKILL ladder) and the child is reaped.
 *
 * Run:  npm run verify:dsh-live
 * Env:  DSH_BIN        (default: installed @deepseek-ai/dsh lib/bin.js)
 *       DEEPSEEK_API_KEY (optional: enables phase 2)
 *
 * Exit 0 only if every executed phase holds. Any crash or hang exits nonzero.
 */

import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshClient } from '../src/dsh/client.ts';
import { buildPolicyPatch, vitalApprovalPluginPath } from '../src/dsh/policy-plugin.ts';
import { DSH_TOOL_CLASSES } from '../src/dsh/policy-snapshot.ts';

const fail = (msg: string): never => {
  console.error(`[dsh-live] FAIL: ${msg}`);
  process.exit(1);
};
const require = createRequire(import.meta.url);
const binPath = process.env.DSH_BIN ?? require.resolve('@deepseek-ai/dsh/lib/bin.js');
const launchArgs = [binPath, '--profile', 'sdk'];

// Optional mount proof for the in-runtime approval answerer (no model call):
// generate a real snapshot + patch via the production builders, boot with
// --patch, and assert the handshake still succeeds with the plugin mounted.
// Decision behavior needs a live-model turn (phase 2 with creds).
if (process.env.DSH_VERIFY_PLUGIN === '1') {
  const dir = mkdtempSync(join(tmpdir(), 'vital-dsh-probe-'));
  process.env.VITAL_POLICY_DIR = dir;
  const sessionId = 'vital-live-probe';
  writeFileSync(
    join(dir, `vital-policy-${sessionId}.json`),
    JSON.stringify({
      version: 1,
      sessionId,
      scope: 'engineering',
      tools: { ...DSH_TOOL_CLASSES },
      killAtStart: false,
      approvedDecisionId: null,
    }),
  );
  const patchPath = join(dir, 'vital-approval.patch.yml');
  writeFileSync(patchPath, buildPolicyPatch(vitalApprovalPluginPath()));
  launchArgs.push('--patch', patchPath);
  console.log('[dsh-live] plugin verification on: snapshot + patch generated via production builders');
}

const client = new DshClient({
  launch: { command: process.execPath, args: launchArgs },
});

// Phase 1: boot + handshake (no model call, no creds).
await client.connect().catch((e) => fail(`connect: ${(e as Error).message}`));
console.log('[dsh-live] phase 1 ok: runtime booted, initialize handshake accepted');

// Phase 2: live turn only with creds.
if (process.env.DEEPSEEK_API_KEY) {
  const timer = setTimeout(() => fail('live turn timed out after 120s'), 120_000);
  try {
    const result = await client.send('vital-live-probe', 'say hi');
    if (!result.finalResponse.trim()) fail('live turn settled idle with an empty final response');
    console.log(`[dsh-live] phase 2 ok: live turn settled, ${result.finalResponse.length} chars`);
  } catch (e) {
    fail(`live turn: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
} else {
  console.log('[dsh-live] phase 2 skipped: DEEPSEEK_API_KEY unset');
}

// Phase 3: teardown reaps the child.
await client.close().catch((e) => fail(`close: ${(e as Error).message}`));
console.log('[dsh-live] phase 3 ok: runtime shut down, child reaped');
console.log('[dsh-live] PASS');
