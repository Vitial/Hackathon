// Fake dsh SDK runtime (stdio JSON-RPC). Speaks just enough of the SDK wire
// for DshClient/DshRunner tests: `initialize`, `session/prompt`, `shutdown`.
// After a prompt it replays a scripted notification sequence selected by
// DSH_FAKE_SCENARIO (happy | deny | budget | error), mirroring how the real
// `dsh --profile sdk` server streams `session.event` + `session.status`.
//
// Run: node test/fake-dsh-runtime.mjs  (stdio; one JSON-RPC frame per line)

let seq = 0;
const now = () => Date.now();
const out = (obj) => {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch {
    /* runner closed us (abort path): die quietly */
  }
};
const respond = (id, result) => out({ jsonrpc: '2.0', id, result });
const notify = (method, params) => out({ jsonrpc: '2.0', method, params });
const ev = (sessionId, type, data) =>
  notify('session.event', { sessionId, event: { type, seq: ++seq, time: now(), data } });
const status = (sessionId, s) => notify('session.status', { sessionId, status: s });
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const assistantMessage = (text, usage) => ({
  turn: 1,
  step: 1,
  message: {
    id: `asst-${seq}`,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model' },
  },
  ...(usage ? { usage } : {}),
});

const SCENARIOS = {
  // Text + one allowlisted tool + usage + clean turn end.
  happy: async (sessionId) => {
    status(sessionId, 'running');
    ev(sessionId, 'turn/start', { turn: 1 });
    ev(sessionId, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'patch applied' },
    });
    await sleep(20);
    ev(sessionId, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' });
    await sleep(20);
    ev(sessionId, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'tool-c1',
        role: 'user',
        content: [{ type: 'tool_result', callId: 'c1', name: 'read', content: 'ok' }],
        source: { kind: 'tool' },
      },
    });
    ev(sessionId, 'assistant/message', assistantMessage('patch applied', { inputTokens: 1000, outputTokens: 500 }));
    ev(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    await sleep(20);
    status(sessionId, 'idle');
  },
  // One irreversible tool: the runner's policy denies it and aborts the turn.
  // Pause after the call so the async deny+close lands before idle.
  deny: async (sessionId) => {
    status(sessionId, 'running');
    ev(sessionId, 'turn/start', { turn: 1 });
    ev(sessionId, 'tool/call', { turn: 1, step: 1, callId: 'c9', name: 'bash', arguments: 'rm -rf /' });
    await sleep(500);
    ev(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    status(sessionId, 'idle');
  },
  // Usage past the test ceiling: the runner aborts on breach.
  budget: async (sessionId) => {
    status(sessionId, 'running');
    ev(sessionId, 'assistant/message', assistantMessage('long output', { inputTokens: 9000, outputTokens: 5000 }));
    await sleep(500);
    ev(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    status(sessionId, 'idle');
  },
  // Turn-level failure.
  error: async (sessionId) => {
    status(sessionId, 'running');
    ev(sessionId, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'E_MODEL' } } });
    await sleep(20);
    status(sessionId, 'idle');
  },
};

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg == null || typeof msg !== 'object') continue;
    const { id, method, params } = msg;
    if (method === 'initialize') {
      respond(id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.0-fake' } });
    } else if (method === 'session/prompt') {
      const sessionId = params?.sessionId ?? 's1';
      const messageId = 'm1';
      respond(id, { messageId });
      // Inbox receipt FIRST: the SDK client ignores pre-receipt notifications.
      ev(sessionId, 'agent/inbox/spliced', { inserted: [{ id: messageId }] });
      const scenario = SCENARIOS[process.env.DSH_FAKE_SCENARIO ?? 'happy'] ?? SCENARIOS.happy;
      void scenario(sessionId).catch(() => {});
    } else if (method === 'shutdown') {
      respond(id, {});
      setTimeout(() => process.exit(0), 50);
    } else if (typeof id === 'string' || typeof id === 'number') {
      out({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
