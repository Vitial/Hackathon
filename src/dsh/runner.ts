import { EventEmitter } from 'node:events';
import type { AsyncDb } from '../core/db.ts';
import type { Ledger } from '../ledger/ledger.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { CoordinationRequest, RoutingClass, SourceTier } from '../core/types.ts';
import { DshClient, type DshClientOptions } from './client.ts';
import { policyPluginEnabled, preparePolicyEnforcement, type PolicyEnforcement } from './policy-plugin.ts';
import type { CodingTask, PermissionPolicy, PermissionVerdict, ProgressUpdate, RunResult } from '../jcode/runner.ts';
import { createGovernedPermissionPolicy } from '../jcode/runner.ts';
import { getRates } from '../attrib/attribution.ts';
import { FilesystemArtifactStore } from '../ingest/collectors.ts';
import { checkKill } from '../gov/trust.ts';
import { verifyScopeToken, assertTokenAudience } from '../substrate/identity.ts';
import { quoteExternal, formatQuotedPrompt } from '../sense/integrity.ts';
import { verifySandbox } from '../substrate/sandbox.ts';
import type { ScreenResult } from '../substrate/screen.ts';

/**
 * The dsh connection.
 *
 * Flow: a coding need becomes a REQUEST -> coordinator admits it (budget,
 * hop limit, grounding) -> we boot a dsh SDK runtime, send the command +
 * instructions -> every tool call is gated by OUR R/A/I policy -> tool
 * activity is recorded -> on idle the deliverable and cost are written back
 * and the request completes.
 *
 * Permission model vs jcode: the SDK wire has no permission round-trip
 * (server→client requests are a reserved-but-unused capability), so the
 * gate is client-side and coarser: an allowed tool runs, a denied tool
 * aborts the whole turn (fail-closed, logged as a Ledger ACTION) instead
 * of being vetoed per-call. The approval-answerer Cordis plugin
 * (src/substrate/dsh-plugins/) restores per-call granularity later; until
 * then no denied tool ever executes — the turn dies first.
 *
 * Abort model vs jcode: the SDK wire has no cancel. Budget breach, kill
 * switch, timeout, and content-screen denial all abort by closing the
 * runtime process (the SDK's documented teardown ladder).
 */

export interface DshRunnerOptions {
  contentScreen?: {
    check: (hook: 'user_input' | 'tool_response', text: string) => ScreenResult;
  };
}

/**
 * Map dsh SDK tool names onto the permission policy's tool vocabulary
 * (built for jcode's read_file/write_file/edit_file/bash set). dsh ships
 * `read`, `write`, `edit`; the classes are what matter — READ,
 * ACT_REVERSIBLE, ACT_IRREVERSIBLE — so map the names and keep the
 * original in the permission record and ledger statement.
 */
export function toPolicyToolName(name: string): string {
  switch (name) {
    case 'read':
      return 'read_file';
    case 'write':
      return 'write_file';
    case 'edit':
      return 'edit_file';
    case 'shell':
      return 'bash';
    default:
      return name;
  }
}

export class DshRunner extends EventEmitter {
  private readonly artifactStore: FilesystemArtifactStore;
  private readonly contentScreen?: {
    check: (hook: 'user_input' | 'tool_response', text: string) => ScreenResult;
  };
  private readonly policy: PermissionPolicy;

  constructor(
    private readonly db: AsyncDb,
    private readonly ledger: Ledger,
    private readonly coord: Coordinator,
    policy?: PermissionPolicy,
    artifactStore?: FilesystemArtifactStore,
    opts: DshRunnerOptions = {},
  ) {
    super();
    this.policy = policy ?? createGovernedPermissionPolicy(db);
    this.artifactStore = artifactStore ?? new FilesystemArtifactStore();
    this.contentScreen = opts.contentScreen;
  }

  /**
   * The only entry point. Takes an already-admitted REQUEST so budget and hop
   * rules cannot be bypassed by calling dsh directly.
   */
  async run(tenant: string, requestId: string, task: CodingTask, clientOpts: DshClientOptions): Promise<RunResult> {
    const req = await this.coord.get(tenant, requestId);
    if (!req) throw new Error(`[dsh] unknown request ${requestId}`);
    if (req.state !== 'ADMITTED' && req.state !== 'ACCEPTED' && req.state !== 'IN_FLIGHT') {
      throw new Error(`[dsh] request ${requestId} is ${req.state}, not executable`);
    }
    if (task.claimRefs.length === 0) {
      throw new Error('[dsh] a coding task must cite the claims it is grounded in');
    }

    // Pre-flight kill switch check
    if ((await checkKill(this.db, tenant, req.targetScope, '*')) || (await checkKill(this.db, tenant, '*', '*'))) {
      const reason = `[dsh:HALTED] kill switch engaged for scope "${req.targetScope}"`;
      await this.audit(tenant, 'dsh', 'KILL_SWITCH_HALTED', requestId, reason);
      try {
        await this.coord.fail(tenant, requestId, reason);
      } catch {
        /* already terminal */
      }
      await this.recordTrace(tenant, req, '', reason, { input: 0, output: 0 }, 'FAILURE', task);
      return {
        requestId,
        sessionId: '',
        status: 'DENIED',
        transcript: '',
        toolCalls: [],
        permissions: [],
        usage: { input: 0, output: 0 },
        claimIds: [],
        refusalReason: reason,
      };
    }

    if (task.scopeToken) {
      const secret = task.coreSecret ?? process.env.VITAL_CORE_SECRET;
      if (!secret) {
        throw new Error('[dsh:IDENTITY] scope token supplied but no VITAL_CORE_SECRET available for verification');
      }
      const grant = verifyScopeToken(secret, task.scopeToken, new Date().toISOString());
      if (grant.scope !== req.targetScope) {
        throw new Error(
          `[dsh:IDENTITY] scope token scope "${grant.scope}" does not match target scope "${req.targetScope}"`,
        );
      }
      try {
        assertTokenAudience(grant, requestId);
      } catch (e) {
        throw new Error(`[dsh:IDENTITY] ${(e as Error).message}`, { cause: e });
      }
    }

    if (task.sandboxManifest) {
      const dir = task.workingDir ?? process.cwd();
      const v = verifySandbox(dir, task.sandboxManifest);
      if (!v.ok) {
        const faults: string[] = [];
        if (v.tampered.length > 0) faults.push(`tampered: ${v.tampered.join(', ')}`);
        if (v.missing.length > 0) faults.push(`missing: ${v.missing.join(', ')}`);
        throw new Error(`[dsh:SANDBOX] sandbox verification failed (${faults.join('; ')})`);
      }
    }

    try {
      await this.coord.claimExecution(tenant, requestId, task.onBehalfOf, new Date().toISOString());
    } catch (e) {
      throw new Error(`[dsh:CLAIM_LOST] ${(e as Error).message}`, { cause: e });
    }

    const rates = await getRates(this.db, tenant);
    const contextClaims = await this.ledger.contextFor(tenant, task.claimRefs, new Date().toISOString());
    let crossRoomClaims: import('../ledger/ledger.ts').Claim[] = [];
    try {
      crossRoomClaims = await this.ledger.search(tenant, {
        q: task.command.slice(0, 100),
        limit: 8,
      });
      const directIds = new Set(contextClaims.map((c) => c.id));
      crossRoomClaims = crossRoomClaims.filter((c) => !directIds.has(c.id));
    } catch {
      // non-fatal
    }

    const quoteClaim = (c: { kind: string; subject: string; id: string; statement: string; scope: string }) => {
      const provenance = (c as { provenance?: { sourceUri?: string; sourceTier?: string } }).provenance;
      const tier: SourceTier = (
        ['SYSTEM_OF_RECORD', 'MEASURED', 'PRIMARY', 'CORROBORATED', 'SINGLE_SOURCE', 'SELF_SERVED'] as const
      ).includes(provenance?.sourceTier as never)
        ? (provenance!.sourceTier as SourceTier)
        : 'SELF_SERVED';
      return formatQuotedPrompt(
        quoteExternal(
          `[${c.kind}] (${c.subject}) [${c.id}]: ${c.statement}`,
          typeof provenance?.sourceUri === 'string' && provenance.sourceUri ? provenance.sourceUri : `ledger:${c.id}`,
          tier,
        ),
      );
    };
    const blocks: string[] = [];
    if (contextClaims.length > 0) {
      const contextLines = contextClaims.map((c) => quoteClaim(c)).join('\n');
      blocks.push(`[Grounded Context]\n${contextLines}`);
    }
    if (crossRoomClaims.length > 0) {
      const crossLines = crossRoomClaims.map((c) => quoteClaim(c)).join('\n');
      blocks.push(`[Cross-Room Evidence]\n${crossLines}`);
    }
    blocks.push(`[Instruction]\n${task.command}`);
    const prompt = blocks.join('\n\n');

    if (this.contentScreen) {
      const screen = this.contentScreen.check('user_input', prompt);
      if (screen.verdict === 'deny') {
        const reason = `[dsh:DENIED] content screen denied input: ${screen.flags.join(', ') || 'unsafe content'}`;
        await this.audit(tenant, 'dsh', 'CONTENT_SCREEN_DENIED', requestId, reason);
        try {
          await this.coord.fail(tenant, requestId, reason);
        } catch {
          /* already terminal */
        }
        await this.recordTrace(tenant, req, '', reason, { input: 0, output: 0 }, 'FAILURE', task);
        return {
          requestId,
          sessionId: '',
          status: 'DENIED',
          transcript: '',
          toolCalls: [],
          permissions: [],
          usage: { input: 0, output: 0 },
          claimIds: [],
          refusalReason: reason,
        };
      }
    }

    let clientOptsWithCwd: DshClientOptions = { ...clientOpts, cwd: clientOpts.cwd ?? task.workingDir };
    const sessionId = `vital-${requestId}`;
    // In-runtime answerer (opt-in): freeze the deterministic policy core to
    // a snapshot file and mount the plugin via a generated --patch overlay.
    // The parent-side gate below stays authoritative regardless.
    let enforcement: PolicyEnforcement | null = null;
    if (policyPluginEnabled()) {
      enforcement = await preparePolicyEnforcement(
        this.db,
        tenant,
        req.targetScope,
        sessionId,
        task.approvedDecisionId,
      );
      clientOptsWithCwd = {
        ...clientOptsWithCwd,
        launch: {
          ...clientOptsWithCwd.launch,
          args: [...(clientOptsWithCwd.launch.args ?? []), '--patch', enforcement.patchPath],
        },
      };
    }
    const client = new DshClient(clientOptsWithCwd);
    const transcript: string[] = [];
    const toolCalls: RunResult['toolCalls'] = [];
    const permissions: RunResult['permissions'] = [];
    const usage = { input: 0, output: 0 };
    const claimIds: string[] = [];
    let budgetBroken = false;
    let turnError: string | null = null;
    let turnEndReason = 'completed';
    let transcriptChars = 0;
    let transcriptTruncated = false;
    const MAX_TRANSCRIPT_CHARS = 64_000;
    const MAX_CLAIM_TOOL_CALLS = 200;
    let step = 0;
    const progress = (toolName?: string): void => {
      step += 1;
      this.emit('progress', {
        requestId,
        sessionId,
        step,
        toolName,
        tokens: usage.input + usage.output,
        usage: { ...usage },
      } satisfies ProgressUpdate);
    };

    // Client-side permission gate: the SDK wire cannot veto a single call,
    // so a deny aborts the whole turn. The denial is a logged Ledger ACTION
    // before the abort — an agent that quietly blocked itself is as invisible
    // as one that quietly acted.
    const onToolStart = async (f: { name: string; call_id: string; arguments: string }) => {
      const toolName = f.name;
      const killed =
        (await checkKill(this.db, tenant, req.targetScope, '*')) || (await checkKill(this.db, tenant, '*', '*'));
      let verdict: PermissionVerdict;
      if (killed) {
        verdict = {
          decision: 'deny',
          reason: `kill switch engaged for scope "${req.targetScope}": mid-turn execution halted`,
          actionClass: 'UNKNOWN',
        };
      } else {
        verdict = await this.policy({
          toolName: toPolicyToolName(toolName),
          description: f.arguments || task.command,
          task,
          tenant,
          scope: req.targetScope,
        });
      }
      permissions.push({
        toolName,
        decision: verdict.decision,
        reason: verdict.reason,
        actionClass: verdict.actionClass,
      });
      const c = await this.ledger.append({
        tenant,
        subject: `dsh:${req.targetScope}`,
        kind: 'ACTION',
        statement: `permission ${verdict.decision.toUpperCase()} for ${toolName}: ${verdict.reason}`,
        confidence: 1,
        owner: task.onBehalfOf,
        scope: req.targetScope,
        authorType: 'agent',
        observedAt: new Date().toISOString(),
        validFrom: new Date().toISOString(),
        provenance: {
          sourceUri: `dsh:session:${sessionId}`,
          sourceTier: 'MEASURED',
          extractor: 'dsh-sdk',
          extractorVersion: 'v1',
          retrievedAt: new Date().toISOString(),
        },
      });
      claimIds.push(c.id);
      await this.audit(tenant, 'dsh', `PERMISSION_${verdict.decision.toUpperCase()}`, requestId, toolName);
      if (verdict.decision !== 'allow' && verdict.decision !== 'allow_always') {
        // No per-call veto on this wire: the turn dies instead of the call.
        // The approval-answerer plugin restores per-call granularity later.
        turnError = `permission denied for ${toolName}: ${verdict.reason}`;
        void client.close().catch(() => {});
      }
    };

    const onText = (f: { text: string }) => {
      if (typeof f.text !== 'string' || f.text.length === 0) return;
      if (this.contentScreen) {
        const screen = this.contentScreen.check('tool_response', f.text);
        if (screen.verdict === 'deny') {
          budgetBroken = true;
          if (turnError === null) {
            turnError = `content screen denied output: ${screen.flags.join(', ') || 'unsafe content'}`;
          }
          void client.close().catch(() => {});
        }
      }
      transcript.push(f.text);
      transcriptChars += f.text.length;
      while (transcriptChars > MAX_TRANSCRIPT_CHARS && transcript.length > 1) {
        transcriptChars -= (transcript.shift() ?? '').length;
        transcriptTruncated = true;
      }
    };

    const onToolDone = (f: { name: string; call_id: string; error: string | null }) => {
      let idx = pendingByCall.get(f.call_id);
      if (idx === undefined && !f.call_id && pendingByCall.size === 1) {
        // Some runtimes omit call correlation on results: with exactly one
        // open call the pairing is unambiguous.
        idx = pendingByCall.values().next().value;
      }
      if (idx !== undefined) {
        for (const [k, v] of pendingByCall) {
          if (v === idx) {
            pendingByCall.delete(k);
            break;
          }
        }
        const entry = toolCalls[idx];
        if (entry) {
          if (!entry.name || entry.name === 'unknown') entry.name = f.name || 'unknown';
          entry.error = f.error;
        }
      } else {
        toolCalls.push({ name: f.name || 'unknown', callId: f.call_id, error: f.error });
      }
      progress(f.name);
    };

    const onUsage = (f: { input: number; output: number }) => {
      const deltaTokens = Number(f.input ?? 0) + Number(f.output ?? 0);
      const deltaDollars = deltaTokens * (rates.dollarPerToken ?? 0);
      usage.input += Number(f.input ?? 0);
      usage.output += Number(f.output ?? 0);
      const tokens = usage.input + usage.output;
      const dollars = tokens * (rates.dollarPerToken ?? 0);
      if (tokens > task.maxTokens || dollars > task.maxDollars) budgetBroken = true;
      this.emit('usage', tokens);
      if (deltaTokens > 0) {
        void this.coord
          .reportUsage(tenant, requestId, { tokens: deltaTokens, dollars: deltaDollars })
          .then((r) => {
            if (r.state === 'TERMINATED_BUDGET') budgetBroken = true;
            progress();
          })
          .catch((e) => {
            this.emit('progressError', { requestId, error: (e as Error).message });
          });
      } else {
        progress();
      }
      if (budgetBroken) {
        void client.close().catch(() => {});
      }
    };

    // tool/start handlers are async (policy + ledger write). Track them so a
    // fast turn cannot finish while a permission decision is still in flight.
    // pendingByCall pairs tool/result frames with their tool/call by call id.
    const inflight = new Set<Promise<unknown>>();
    const pendingByCall = new Map<string, number>();
    client.on('frame:tool_start', (f) => {
      const sf = f as { name: string; call_id: string; arguments: string };
      pendingByCall.set(sf.call_id, toolCalls.length);
      toolCalls.push({ name: sf.name, callId: sf.call_id, error: null });
      const p = onToolStart(sf).catch((e) => {
        if (turnError === null) turnError = `permission gate failed: ${(e as Error).message}`;
        void client.close().catch(() => {});
      });
      inflight.add(p);
      void p.finally(() => {
        inflight.delete(p);
      });
    });
    client.on('frame:text_delta', (f) => onText(f as { text: string }));
    client.on('frame:tool_done', (f) => onToolDone(f as { name: string; call_id: string; error: string | null }));
    client.on('frame:token_usage', (f) => onUsage(f as { input: number; output: number }));
    client.on('frame:turn_done', (f) => {
      turnEndReason = String((f as { reason: string }).reason ?? 'completed');
    });

    let status: RunResult['status'] = 'COMPLETED';
    let refusalReason: string | undefined;

    const leaseHeartbeat = setInterval(() => {
      void (async () => {
        const killed =
          (await checkKill(this.db, tenant, req.targetScope, '*')) || (await checkKill(this.db, tenant, '*', '*'));
        if (killed && turnError === null) {
          turnError = `kill switch engaged for scope "${req.targetScope}": mid-turn execution halted`;
          void client.close().catch(() => {});
        }
        await this.coord.renewExecutionLease(tenant, requestId, task.onBehalfOf, new Date().toISOString());
      })().catch((e) => {
        if (turnError === null) {
          turnError = `execution lease lost: ${(e as Error).message}`;
        }
      });
    }, 25_000);
    leaseHeartbeat.unref?.();

    try {
      await client.connect();
      const timeoutMs = task.turnTimeoutMs ?? 60_000;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (turnError === null) turnError = 'harness turn did not complete';
        void client.close().catch(() => {});
      }, timeoutMs);
      timer.unref?.();

      let runResult;
      try {
        runResult = await client.send(sessionId, prompt);
      } catch (e) {
        // close()-driven aborts surface as transport errors: reclassify them
        // by the flag that caused the abort, not the teardown noise.
        if (turnError === null) turnError = (e as Error).message;
      } finally {
        clearTimeout(timer);
      }
      void runResult;

      if (inflight.size > 0) {
        await Promise.race([Promise.allSettled([...inflight]), new Promise((res) => setTimeout(res, 5_000))]);
      }
      if (budgetBroken) {
        status = 'TERMINATED_BUDGET';
        refusalReason = 'token ceiling reached';
      } else if (timedOut) {
        status = 'FAILED';
        refusalReason = 'harness turn did not complete';
      } else if (turnError !== null) {
        status = turnError.includes('kill switch') || turnError.includes('content screen') ? 'DENIED' : 'FAILED';
        refusalReason = turnError;
      } else if (turnEndReason === 'max-tokens') {
        status = 'TERMINATED_BUDGET';
        refusalReason = 'token ceiling reached';
      } else if (turnEndReason === 'error' || turnEndReason === 'blocked' || turnEndReason === 'interrupted') {
        status = 'FAILED';
        refusalReason = `harness turn ended: ${turnEndReason}`;
      } else if (turnEndReason === 'aborted') {
        status = 'FAILED';
        refusalReason = 'harness turn aborted';
      }

      const rawTranscript = transcript.join('');
      let artifactRef: string | undefined;
      try {
        const safeTenant = tenant.replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeReq = requestId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const artifactName = `dsh-${safeTenant}-${safeReq}-${Date.now()}.txt`;
        artifactRef = this.artifactStore.put(artifactName, rawTranscript);
      } catch (e) {
        this.emit('progressError', { requestId, error: `artifact store failed: ${(e as Error).message}` });
      }

      const summary = rawTranscript.slice(0, 4000);
      const out = await this.ledger.append({
        tenant,
        subject: `dsh:${req.targetScope}`,
        kind: 'OBSERVATION',
        statement: `harness run: ${toolCalls.length} tool calls, ${usage.input + usage.output} tokens${transcriptTruncated ? ' (transcript truncated)' : ''}`,
        value: {
          toolCalls: toolCalls.slice(0, MAX_CLAIM_TOOL_CALLS),
          totalToolCalls: toolCalls.length,
          toolCallsTruncated: toolCalls.length > MAX_CLAIM_TOOL_CALLS,
          transcriptTruncated,
          usage,
          permissions,
          fullTextRef: artifactRef ?? null,
        },
        confidence: 1,
        owner: task.onBehalfOf,
        scope: req.targetScope,
        authorType: 'agent',
        observedAt: new Date().toISOString(),
        validFrom: new Date().toISOString(),
        provenance: {
          sourceUri: `dsh:session:${sessionId}`,
          sourceTier: 'MEASURED',
          extractor: 'dsh-sdk',
          extractorVersion: 'v1',
          retrievedAt: new Date().toISOString(),
          rawArtifactRef: artifactRef,
        },
      });
      claimIds.push(out.id);

      if (status === 'COMPLETED') {
        await this.coord.complete(tenant, requestId, {
          claims: claimIds,
          cost: {
            tokens: usage.input + usage.output,
            dollars: (usage.input + usage.output) * (rates.dollarPerToken ?? 0),
          },
        });
        await this.recordTrace(tenant, req, sessionId, summary, usage, 'SUCCESS', task);
      } else {
        const current = await this.coord.get(tenant, requestId);
        if (current?.state === 'TERMINATED_BUDGET') {
          status = 'TERMINATED_BUDGET';
          refusalReason = current.refusalReason ?? refusalReason;
        } else {
          await this.coord.fail(tenant, requestId, refusalReason ?? 'unknown failure');
        }
        await this.recordTrace(tenant, req, sessionId, refusalReason ?? summary, usage, 'FAILURE', task);
      }
      return {
        requestId,
        sessionId,
        status,
        transcript: transcript.join(''),
        toolCalls: toolCalls.map((t) => ({ name: t.name, callId: t.callId, error: t.error ?? null })),
        permissions,
        usage,
        claimIds,
        refusalReason,
        artifactRef,
      };
    } catch (e) {
      const msg = (e as Error).message;
      status = msg.includes('[dsh:HALTED]') || msg.includes('[dsh:DENIED]') ? 'DENIED' : 'FAILED';
      refusalReason = msg;
      try {
        await this.coord.fail(tenant, requestId, refusalReason);
      } catch {
        /* already terminal */
      }
      if (req) {
        try {
          await this.recordTrace(tenant, req, sessionId, msg, usage, 'FAILURE', task);
        } catch {
          /* ignore secondary trace failure */
        }
      }
      return {
        requestId,
        sessionId,
        status,
        transcript: transcript.join(''),
        toolCalls: toolCalls.map((t) => ({ name: t.name, callId: t.callId, error: t.error ?? null })),
        permissions,
        usage,
        claimIds,
        refusalReason,
      };
    } finally {
      clearInterval(leaseHeartbeat);
      await client.close().catch(() => {});
      enforcement?.cleanup();
    }
  }

  /** A completed or failed run becomes a TRACE eligible for compilation or drift monitoring. */
  private async recordTrace(
    tenant: string,
    req: CoordinationRequest,
    sessionId: string,
    summary: string,
    usage: { input: number; output: number },
    outcome: 'SUCCESS' | 'FAILURE' = 'SUCCESS',
    meta: {
      taskType?: string;
      tier?: RoutingClass;
      intent?: string;
      skillCardId?: string | null;
      routerConfidence?: number;
    } = {},
  ): Promise<void> {
    const taskType = meta.taskType ?? 'engineering.implement';
    const tier = meta.tier ?? 'MODEL';
    const intent = meta.intent ?? `code:${req.deliverableSchema}`;
    const skillCardId = meta.skillCardId ?? null;
    const routerConfidence = meta.routerConfidence ?? 0.9;
    await this.db
      .prepare(
        `INSERT INTO traces (id,tenant,request_id,scope,task_type,intent,steps,tier,outcome,cost_json,skill_card,router_confidence,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `tr_${crypto.randomUUID()}`,
        tenant,
        req.id,
        req.targetScope,
        taskType,
        intent,
        JSON.stringify({ sessionId, summary: summary.slice(0, 500) }),
        tier,
        outcome,
        JSON.stringify({ tokens: usage.input + usage.output }),
        skillCardId,
        routerConfidence,
        new Date().toISOString(),
      );
  }

  private async audit(tenant: string, actor: string, action: string, target: string, detail?: string): Promise<void> {
    await this.db
      .prepare('INSERT INTO audit_log (tenant, actor, action, target, detail, at) VALUES (?,?,?,?,?,?)')
      .run(tenant, actor, action, target, detail ?? null, new Date().toISOString());
  }
}
