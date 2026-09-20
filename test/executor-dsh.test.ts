import { T, eq, TEN, NOW, fresh, sor, base, rejects } from './helpers.ts';
import { fileURLToPath } from 'node:url';
import { runJob } from '../src/aws/executor.ts';
console.log('\n\x1b[1mexecutor harnessed lane — the real runtime in the microVM\x1b[0m');

const fixture = fileURLToPath(new URL('./fake-dsh-runtime.mjs', import.meta.url));

function dshEnv(): NodeJS.ProcessEnv {
  return { DSH_ENABLED: '1', DSH_ARGS: fixture };
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

T('DSH_ENABLED=1 runs the job through the harness, not the chat call', async () => {
  process.env.DSH_FAKE_SCENARIO = 'happy';
  const { db, ledger, coord, clm, request } = await setup('e1');
  const out = await runJob(
    db,
    {
      tenant: TEN,
      requestId: request.id,
      prompt: 'Add EU region streaming behind a flag.',
      claimRefs: [clm.id],
      onBehalfOf: 'lambda:e1',
    },
    dshEnv(),
    async () => {
      throw new Error('chat must not be called in harness mode');
    },
  );
  eq(out.status, 'COMPLETED');
  eq(out.claimIds.length > 0, true, 'runner-banked claims travel with the result:');
  eq(out.usage, { input: 1000, output: 500 });
  const after = (await coord.get(TEN, request.id))!;
  eq(after.state, 'COMPLETED');
  eq(after.spent.tokens, 1500, 'usage charged through the coordinator:');
  const art = (await db
    .prepare('SELECT body, claim_id, model FROM executor_artifacts WHERE request_id = ?')
    .get(request.id)) as { body: string; claim_id: string; model: string };
  eq(art.body.includes('patch applied'), true, 'transcript persisted to the DB artifact table:');
  eq(art.model, 'dsh');
  eq(out.claimIds.includes(art.claim_id), true, 'artifact links the runner closing claim:');
  void ledger;
});

T('a denied tool fails the job with the refusal reason', async () => {
  process.env.DSH_FAKE_SCENARIO = 'deny';
  const { db, ledger, coord, clm, request } = await setup('e2');
  const out = await runJob(
    db,
    { tenant: TEN, requestId: request.id, prompt: 'wipe the disk', claimRefs: [clm.id], onBehalfOf: 'lambda:e2' },
    dshEnv(),
  );
  eq(out.status, 'FAILED');
  eq((out.error ?? '').includes('permission denied for bash'), true, `refusal travels (${out.error}):`);
  eq((await coord.get(TEN, request.id))!.state, 'FAILED');
  void ledger;
});

T('an allowlisted egress closes the harness lane before any spend', async () => {
  process.env.DSH_FAKE_SCENARIO = 'happy';
  const { db, ledger, coord, clm, request } = await setup('e3');
  await rejects(
    async () =>
      await runJob(
        db,
        { tenant: TEN, requestId: request.id, prompt: 'do it', claimRefs: [clm.id], onBehalfOf: 'lambda:e3' },
        { ...dshEnv(), ALLOWED_EGRESS_HOSTS: 'api.serper.dev' },
      ),
    'EGRESS',
  );
  void ledger;
  void coord;
});

T('ungrounded work throws: the agentic lane can act, not just talk', async () => {
  // Admission (coordinator UNGROUNDED_WORK) already blocks claim-free
  // REQUESTs, so the executor path cannot produce this — it bites only on
  // direct runner misuse. Prove it at the runner level.
  process.env.DSH_FAKE_SCENARIO = 'happy';
  const { db, ledger, coord, request } = await setup('e4');
  const { DshRunner } = await import('../src/dsh/runner.ts');
  const r = new DshRunner(db, ledger, coord);
  await rejects(
    async () =>
      await r.run(
        TEN,
        request.id,
        { command: 'do it', claimRefs: [], onBehalfOf: 'lambda:e4', maxDollars: 5, maxTokens: 100_000 },
        { launch: { command: process.execPath, args: [fixture] } },
      ),
    'grounded',
  );
  void ledger;
  void coord;
});
