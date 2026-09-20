import { T, eq, TEN, fresh } from './helpers.ts';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DSH_TOOL_CLASSES,
  buildPolicySnapshot,
  snapshotPathFor,
  writePolicySnapshot,
  removePolicySnapshot,
} from '../src/dsh/policy-snapshot.ts';
import {
  buildVitalPatch,
  preparePolicyEnforcement,
  vitalApprovalPluginPath,
  vitalGovernancePluginPath,
} from '../src/dsh/policy-plugin.ts';
import { decide } from '../src/dsh/vital-approval.mjs';
import { SECTION_NAME, SECTION_ORDER, SECTION_TEXT } from '../src/dsh/vital-governance.mjs';
import { toPolicyToolName } from '../src/dsh/runner.ts';
console.log('\n\x1b[1mdsh policy snapshot + approval plugin\x1b[0m');

T('the roster maps the sdk tools onto Vital action classes', () => {
  eq(DSH_TOOL_CLASSES.read, 'READ');
  eq(DSH_TOOL_CLASSES.write, 'ACT_REVERSIBLE');
  eq(DSH_TOOL_CLASSES.edit, 'ACT_REVERSIBLE');
  eq(DSH_TOOL_CLASSES.bash, 'ACT_IRREVERSIBLE');
});

T('the snapshot freezes kill state and drops unverified approval bindings', async () => {
  const { db } = await fresh();
  const snap = await buildPolicySnapshot(db, TEN, 'engineering', 'vital-r1', 'no-such-decision');
  eq(snap.version, 1);
  eq(snap.sessionId, 'vital-r1');
  eq(snap.killAtStart, false);
  eq(snap.approvedDecisionId, null);
});

T('snapshot write/read round-trips through the session-derived path', async () => {
  const { db } = await fresh();
  const dir = mkdtempSync(join(tmpdir(), 'vital-policy-test-'));
  const snap = await buildPolicySnapshot(db, TEN, 'engineering', 'vital-r2');
  const path = writePolicySnapshot(dir, snap);
  eq(path, snapshotPathFor(dir, 'vital-r2'));
  eq(existsSync(path), true);
  removePolicySnapshot(path);
  eq(existsSync(path), false);
});

T('the plugin decides from the snapshot: allow reads, gate writes, deny shell', () => {
  const base = {
    version: 1,
    sessionId: 'vital-r3',
    scope: 'engineering',
    tools: { ...DSH_TOOL_CLASSES },
    killAtStart: false,
    approvedDecisionId: null,
  };
  eq(decide(base, 'read'), 'allowed-once');
  eq(decide(base, 'write'), 'rejected');
  eq(decide(base, 'bash'), 'rejected');
  eq(decide(base, 'unknown-tool'), 'delegate');
  eq(decide(null, 'read'), 'delegate');
  eq(decide({ ...base, killAtStart: true }, 'read'), 'rejected');
  eq(decide({ ...base, approvedDecisionId: 'dec-1' }, 'write'), 'allowed-once');
});

T('the plugin answers from the on-disk snapshot for its own session', async () => {
  const mod = await import('../src/dsh/vital-approval.mjs');
  const apply = (mod as unknown as { apply: (ctx: unknown) => void }).apply;
  const dir = mkdtempSync(join(tmpdir(), 'vital-policy-test-'));
  process.env.VITAL_POLICY_DIR = dir;
  try {
    const { db } = await fresh();
    const snap = await buildPolicySnapshot(db, TEN, 'engineering', 'vital-r4');
    writePolicySnapshot(dir, snap);
    const seen: { verdict: unknown }[] = [];
    const ctx = {
      on: (_ev: string, fn: (req: unknown, next: () => unknown) => unknown) => {
        seen.push({
          verdict: fn({ agent: { session: { id: 'vital-r4' } }, toolName: 'read' }, () => 'delegated'),
        });
        seen.push({
          verdict: fn({ agent: { session: { id: 'vital-r4' } }, toolName: 'bash' }, () => 'delegated'),
        });
        seen.push({
          verdict: fn({ agent: { session: { id: 'other-session' } }, toolName: 'read' }, () => 'delegated'),
        });
      },
    };
    apply(ctx);
    eq(seen[0]!.verdict, 'allowed-once');
    eq(seen[1]!.verdict, 'rejected');
    // Unknown session: no snapshot -> delegate, downstream fails closed.
    eq(seen[2]!.verdict, 'delegated');
  } finally {
    delete process.env.VITAL_POLICY_DIR;
  }
});

T('the generated patch mounts the real plugin file by absolute path', async () => {
  const { db } = await fresh();
  const prep = await preparePolicyEnforcement(db, TEN, 'engineering', 'vital-r5');
  try {
    eq(existsSync(prep.snapshotPath), true);
    eq(existsSync(prep.patchPath), true);
    eq(vitalApprovalPluginPath().endsWith('vital-approval.mjs'), true);
    const { readFileSync } = await import('node:fs');
    const patch = readFileSync(prep.patchPath, 'utf8');
    eq(patch.includes('vital-approval'), true);
    eq(patch.includes('vital-governance'), true);
    eq(patch.includes(vitalApprovalPluginPath()), true);
    eq(patch.includes(vitalGovernancePluginPath()), true);
  } finally {
    prep.cleanup();
    eq(existsSync(prep.snapshotPath), false);
  }
});

T('the patch builder quotes paths safely', () => {
  const patch = buildVitalPatch(`C:\\we'ird\\a.mjs`, `/x/b.mjs`);
  eq(patch.includes(`'C:\\we''ird\\a.mjs'`), true);
  eq(patch.includes(`'/x/b.mjs'`), true);
  eq(patch.includes('inject: [approval]'), true);
  eq(patch.includes('inject: [systemPrompt]'), true);
});

T('the governance plugin registers an additive preamble section', async () => {
  const mod = await import('../src/dsh/vital-governance.mjs');
  const seen: { name: string; order: number; text: string; interpolate?: boolean }[] = [];
  const apply = (mod as unknown as { apply: (ctx: unknown) => void }).apply;
  apply({
    systemPrompt: {
      section: (s: { name: string; order: number; text: string; interpolate?: boolean }) => {
        seen.push(s);
      },
    },
  });
  eq(seen.length, 1);
  eq(seen[0]!.name, SECTION_NAME);
  eq(seen[0]!.order, SECTION_ORDER);
  eq(seen[0]!.text, SECTION_TEXT);
  eq(seen[0]!.interpolate, false);
  eq(SECTION_TEXT.includes('{{'), false, 'no template braces: strict variables would fail assembly:');
});

T('roster and policy mapping agree on every classified tool', () => {
  const cases: [string, string][] = [
    ['read', 'read_file'],
    ['glob', 'read_file'],
    ['grep', 'read_file'],
    ['read_image', 'read_file'],
    ['todo_write', 'read_file'],
    ['write', 'write_file'],
    ['edit', 'edit_file'],
    ['bash', 'bash'],
    ['pwsh', 'bash'],
    ['shell', 'bash'],
  ];
  for (const [dsh, policy] of cases) {
    eq(toPolicyToolName(dsh), policy, `${dsh} maps to ${policy}:`);
    eq(DSH_TOOL_CLASSES[dsh] !== undefined, true, `${dsh} is classified in the snapshot roster:`);
  }
  // Unmapped tools pass through to deny-by-default on both sides.
  eq(toPolicyToolName('subagent'), 'subagent');
  eq(DSH_TOOL_CLASSES['subagent'], undefined);
  eq(toPolicyToolName('web'), 'web');
  eq(DSH_TOOL_CLASSES['web'], undefined);
});
