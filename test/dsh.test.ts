import { T, eq, TEN, NOW, fresh, sor, base } from './helpers.ts';
import { fileURLToPath } from 'node:url';
import { DshRunner } from '../src/dsh/runner.ts';
import { DshAdapter } from '../src/dsh/adapter.ts';
import { selectAdapter, type HarnessAdapter } from '../src/substrate/harness.ts';
import type { DshClientOptions } from '../src/dsh/client.ts';
console.log('\n\x1b[1mdsh adapter — the SDK wire contract\x1b[0m');

const fixture = fileURLToPath(new URL('./fake-dsh-runtime.mjs', import.meta.url));

function dshOpts(scenario: string): DshClientOptions {
  process.env.DSH_FAKE_SCENARIO = scenario;
  return {
    launch: { command: process.execPath, args: [fixture] },
    maxTokens: 100_000,
  };
}

async function setup(id: string) {
  const { db, ledger, coord } = await fresh();
  const clm = await ledger.append({
    tenant: TEN,
    subject: 'release',
    kind: 'OBSERVATION',
    statement: 'v2.14 shipped',
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'sync:gh',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  const { request } = await coord.submit(
    base({
      id,
      goal: 'implement the EU streaming flag',
      claimRefs: [clm.id],
      deliverableSchema: 'code-change.v1',
      bid: { dollars: 5, tokens: 100_000 },
    }),
  );
  return { db, ledger, coord, clm, request };
}

T('session/prompt -> events -> idle completes and collects the transcript', async () => {
  const { db, ledger, coord, clm, request } = await setup('d1');
  const r = new DshRunner(db, ledger, coord);
  const out = await r.run(
    TEN,
    request.id,
    {
      command: 'Add EU region streaming behind a flag; run tests.',
      claimRefs: [clm.id],
      onBehalfOf: 'human:priya',
      maxDollars: 5,
      maxTokens: 100_000,
      turnTimeoutMs: 20_000,
    },
    dshOpts('happy'),
  );
  eq(out.status, 'COMPLETED');
  eq(out.transcript.includes('patch applied'), true);
  eq(out.toolCalls.length, 1);
  eq(out.toolCalls[0]!.name, 'read');
  eq((await coord.get(TEN, request.id))!.state, 'COMPLETED');
  eq(out.usage.input + out.usage.output, 1500);
  eq(out.permissions[0]!.decision, 'allow');
  eq(out.permissions[0]!.actionClass, 'READ');
});

T('a denied tool aborts the turn instead of executing', async () => {
  const { db, ledger, coord, clm, request } = await setup('d2');
  const r = new DshRunner(db, ledger, coord);
  const out = await r.run(
    TEN,
    request.id,
    {
      command: 'wipe the disk',
      claimRefs: [clm.id],
      onBehalfOf: 'human:priya',
      maxDollars: 5,
      maxTokens: 100_000,
      turnTimeoutMs: 20_000,
    },
    dshOpts('deny'),
  );
  // No per-call veto on the SDK wire: the turn dies instead of the call.
  eq(out.permissions[0]!.toolName, 'bash');
  eq(out.permissions[0]!.decision, 'deny');
  eq(out.permissions[0]!.actionClass, 'ACT_IRREVERSIBLE');
  eq(out.status, 'FAILED');
  eq(out.refusalReason!.includes('permission denied for bash'), true);
});

T('the token ceiling terminates the run', async () => {
  const { db, ledger, coord, clm, request } = await setup('d3');
  const r = new DshRunner(db, ledger, coord);
  const out = await r.run(
    TEN,
    request.id,
    {
      command: 'write a novel',
      claimRefs: [clm.id],
      onBehalfOf: 'human:priya',
      maxDollars: 5,
      maxTokens: 10_000,
      turnTimeoutMs: 20_000,
    },
    dshOpts('budget'),
  );
  eq(out.status, 'TERMINATED_BUDGET');
});

T('a turn error fails the run', async () => {
  const { db, ledger, coord, clm, request } = await setup('d4');
  const r = new DshRunner(db, ledger, coord);
  const out = await r.run(
    TEN,
    request.id,
    {
      command: 'do it',
      claimRefs: [clm.id],
      onBehalfOf: 'human:priya',
      maxDollars: 5,
      maxTokens: 100_000,
      turnTimeoutMs: 20_000,
    },
    dshOpts('error'),
  );
  eq(out.status, 'FAILED');
  eq(out.refusalReason!.includes('error'), true);
});

T('DshAdapter maps the run onto the HarnessOutcome contract', async () => {
  const { db, ledger, coord, clm, request } = await setup('d5');
  const a = new DshAdapter(db, ledger, coord, dshOpts('happy'));
  eq(a.name, 'dsh');
  eq(a.isTestBaseline, false);
  const out = await a.run(TEN, request.id, {
    command: 'Add EU region streaming behind a flag.',
    claimRefs: [clm.id],
    onBehalfOf: 'human:priya',
    maxDollars: 5,
    maxTokens: 100_000,
    turnTimeoutMs: 20_000,
  });
  eq(out.adapter, 'dsh');
  eq(out.requestId, request.id);
  eq(out.status, 'COMPLETED');
  eq(out.tools, ['read']);
  eq(out.isTestBaseline, false);
});

T('selectAdapter prefers dsh, then jcode, for engineering work', async () => {
  const stub = (name: string) => ({ name }) as unknown as HarnessAdapter;
  eq(selectAdapter('engineering.implement', [stub('jcode'), stub('dsh')]).name, 'dsh');
  eq(selectAdapter('engineering.implement', [stub('jcode'), stub('local-echo')]).name, 'jcode');
  eq(selectAdapter('analysis.summarize', [stub('local-echo')]).name, 'local-echo');
});
