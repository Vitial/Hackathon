import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import { DshRunner } from './runner.ts';
import type { DshClientOptions } from './client.ts';
import type { PermissionPolicy } from '../jcode/runner.ts';
import type { HarnessAdapter, HarnessOutcome, HarnessTask } from '../substrate/harness.ts';

/**
 * DshAdapter: the deepseek-harness SDK runtime as a HarnessAdapter.
 * Same contract as JcodeAdapter — the worker, coordinator, ledger, and
 * transfer-test paths are transport-agnostic. `isTestBaseline` is false:
 * this is a real model harness, so the worker provisions a real workspace.
 */
export class DshAdapter implements HarnessAdapter {
  readonly name = 'dsh';
  readonly category = 'model' as const;
  readonly isTestBaseline = false;
  readonly model: string;

  constructor(
    private readonly db: AsyncDb,
    private readonly ledger: Ledger,
    private readonly coord: Coordinator,
    private readonly clientOpts: DshClientOptions,
    private readonly policy?: PermissionPolicy,
    model = 'dsh-agent',
  ) {
    this.model = model;
  }

  async run(tenant: string, requestId: string, task: HarnessTask): Promise<HarnessOutcome> {
    const runner = new DshRunner(this.db, this.ledger, this.coord, this.policy);
    const out = await runner.run(tenant, requestId, task, this.clientOpts);
    return {
      adapter: this.name,
      requestId,
      status: out.status,
      transcript: out.transcript,
      tools: out.toolCalls.map((t) => t.name),
      usage: out.usage,
      permissions: out.permissions.map((p) => ({ tool: p.toolName, decision: p.decision })),
      isTestBaseline: false,
      artifactRef: out.artifactRef,
      refusalReason: out.refusalReason,
    };
  }
}
