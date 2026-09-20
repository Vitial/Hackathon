import { EventEmitter } from 'node:events';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import type { HarnessNotification, DeepSeekHarnessOptions, RunResult } from '@deepseek-ai/dsh-sdk-client';

/**
 * DshClient: wraps the dsh SDK client to match the JcodeClient event
 * interface. The SDK's `run()` is blocking (prompt → idle), but its
 * `onNotification` callback gives us streaming events. We bridge the two:
 * `send()` starts the blocking run, and events flow through the EventEmitter
 * interface so the runner can handle them incrementally.
 *
 * Transport: JSON-RPC over stdio (dsh --profile sdk).
 * No mid-turn cancel in the wire — closing the process is the only abort.
 */

export interface DshClientOptions {
  /** Launch spec for the dsh runtime subprocess. */
  launch: DeepSeekHarnessOptions['launch'];
  /** Workspace cwd for SDK-created sessions. */
  cwd?: string;
  /** Provider route (default: deepseek-official). */
  provider?: string;
  /** Model name (default: deepseek-v4-flash). */
  model?: string;
  /** Max output tokens per request. */
  maxTokens?: number;
}

export class DshClient extends EventEmitter {
  private harness: DeepSeekHarness | null = null;
  private started = false;

  constructor(private readonly opts: DshClientOptions) {
    super();
  }

  get isOpen(): boolean {
    return this.started && this.harness !== null;
  }

  async connect(): Promise<void> {
    if (this.started) throw new Error('[dsh:ALREADY_OPEN] call close() first');
    this.harness = new DeepSeekHarness({
      launch: this.opts.launch,
      cwd: this.opts.cwd,
      provider: this.opts.provider,
      model: this.opts.model,
      maxTokens: this.opts.maxTokens,
    });
    await this.harness.start();
    this.started = true;
  }

  /**
   * Send a prompt to a session and collect events until idle.
   * The SDK's `run()` blocks until the agent becomes idle; events stream
   * through the `onNotification` callback and are re-emitted as
   * `frame:*` events for the runner.
   */
  async send(sessionId: string | undefined, content: string): Promise<RunResult> {
    if (!this.harness) throw new Error('[dsh:NOT_CONNECTED] connect() first');
    const session = this.harness.session(sessionId);
    return session.run(content, {
      onNotification: (n) => this.emitNotification(n),
    });
  }

  /**
   * Close the runtime process. No mid-turn cancel exists in the SDK wire —
   * this is the only abort mechanism.
   */
  async close(): Promise<void> {
    if (this.harness) {
      await this.harness.close().catch(() => {});
      this.harness = null;
    }
    this.started = false;
  }

  /**
   * Map SDK notifications to the `frame:*` event interface the runner
   * expects. The event names are intentionally compatible with jcode's
   * frame vocabulary so the runner can handle both transports with
   * similar handlers.
   */
  private emitNotification(n: HarnessNotification): void {
    const params = n.params as Record<string, unknown>;
    this.emit('notification', params);

    if (n.method === 'session.event') {
      const ev = params.event as Record<string, unknown> | undefined;
      if (!ev) return;
      const type = String(ev.type ?? '');
      const data = (ev.data ?? {}) as Record<string, unknown>;

      if (type === 'assistant/chunk') {
        const chunk = (data.chunk ?? {}) as Record<string, unknown>;
        if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && typeof chunk.text === 'string') {
          this.emit('frame:text_delta', { text: chunk.text });
        }
      } else if (type === 'assistant/message') {
        this.emit('frame:assistant_message', { content: data.message });
        const usage = (data.usage ?? {}) as Record<string, unknown>;
        if (typeof usage.inputTokens === 'number' || typeof usage.outputTokens === 'number') {
          // Billed input = uncached + cached (dsh reports them disjoint).
          const input =
            Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0) + Number(usage.cacheWriteTokens ?? 0);
          this.emit('frame:token_usage', { input, output: Number(usage.outputTokens ?? 0) });
        }
      } else if (type === 'tool/call') {
        this.emit('frame:tool_start', {
          name: String(data.name ?? ''),
          call_id: String(data.callId ?? ''),
          arguments: typeof data.arguments === 'string' ? data.arguments : '',
        });
      } else if (type === 'tool/result') {
        const msg = (data.message ?? {}) as Record<string, unknown>;
        const blocks = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
        const block = blocks[0] ?? {};
        this.emit('frame:tool_done', {
          name: String(block.name ?? ''),
          call_id: String(block.callId ?? block.call_id ?? ''),
          error: data.error ? String((data.error as Record<string, unknown>).code ?? 'tool error') : null,
        });
      } else if (type === 'turn/end') {
        const reason = (data.reason ?? {}) as Record<string, unknown>;
        this.emit('frame:turn_done', { session_id: params.sessionId, reason: String(reason.kind ?? 'completed') });
      } else if (type === 'request/context') {
        this.emit('frame:request_context', data);
      }
    } else if (n.method === 'session.status') {
      this.emit('frame:status', {
        session_id: params.sessionId,
        status: params.status,
      });
    } else if (n.method === 'subagent.started') {
      this.emit('frame:subagent_started', params);
    } else if (n.method === 'subagent.finished') {
      this.emit('frame:subagent_finished', params);
    }
  }
}
