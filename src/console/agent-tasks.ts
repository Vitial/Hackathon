/**
 * Agent Tasks — the read-model and HTML fragments for monitoring long-running
 * Jcode coding-agent executions ("Ongoing Tasks").
 *
 * Grounding (docs/agent-tasks-dashboard.md §1.5): the Jcode swarm is THREE
 * distinct mechanisms, and this page renders each from the real column that
 * backs it — never conflating them:
 *   • A single run's lifecycle  → the row itself (state, spent, execOwner).
 *   • Decomposition (Coordinator.split) → the ONLY true `parent_request` tree,
 *     rendered as nested rows.
 *   • Swarm deliberation (talk/swarm) → unparented requests chained by
 *     `hop_chain`; rendered as a flat chain rail, NEVER nested as children.
 *
 * Honesty rule (mirrors components.ts): every number is derived from a real
 * request field. Nothing is invented — a request with no children shows no
 * child count, a request with no budget ceiling shows the raw spend.
 *
 * This module is pure: it takes `CoordinationRequest[]` + a `now` instant and
 * returns view-models and HTML strings. It owns no database and no server.
 */

import type { CoordinationRequest } from '../core/types.ts';
import { esc, requestDetailUrl, withReturnTo } from './render.ts';
import {
  emptyState,
  pageHeader,
  reviewTone,
  sectionHeader,
  statusChip,
  timeline,
  toneOf,
  type TimelineItem,
} from './components.ts';

/** A settled task. The list shows only the non-terminal set; the tree shows all. */
export const TERMINAL_STATES = new Set(['COMPLETED', 'DECLINED', 'FAILED', 'EXPIRED', 'TERMINATED_BUDGET', 'DENIED']);

/** Seconds after which an IN_FLIGHT task with no write is considered quiet. */
const PROCESSING_WINDOW_MS = 30_000;

/** One agent's derived real-time state. `tone` maps onto a `.v-badge-*`. */
export type AgentRuntime = 'processing' | 'waiting' | 'done' | 'risk';

export interface DerivedStatus {
  /** CSS tone suffix: good | warn | risk | info | ("" = neutral). */
  tone: string;
  /** Human label (the raw state, which is the honest thing to show). */
  label: string;
  runtime: AgentRuntime;
}

const minutesAgo = (now: string, iso: string): number => (Date.parse(now) - Date.parse(iso)) / 60_000;

/**
 * Map a request state (plus recency for IN_FLIGHT) onto a badge tone and a
 * derived runtime state. There is no per-agent status column anywhere in the
 * schema, so "processing" vs "waiting" is *derived* from whether the row has a
 * recent write — the spec's central constraint.
 */
export function deriveStatus(r: CoordinationRequest, now: string): DerivedStatus {
  switch (r.state) {
    case 'COMPLETED':
      return { tone: 'good', label: 'COMPLETED', runtime: 'done' };
    case 'FAILED':
    case 'DENIED':
      return { tone: 'risk', label: r.state, runtime: 'risk' };
    case 'TERMINATED_BUDGET':
      return { tone: 'warn', label: 'TERMINATED_BUDGET', runtime: 'risk' };
    case 'EXPIRED':
    case 'DECLINED':
      return { tone: 'warn', label: r.state, runtime: 'risk' };
    case 'IN_FLIGHT': {
      const quiet = minutesAgo(now, r.updatedAt) * 1000 > PROCESSING_WINDOW_MS;
      return quiet
        ? { tone: 'info', label: 'IN_FLIGHT', runtime: 'waiting' }
        : { tone: 'info', label: 'IN_FLIGHT', runtime: 'processing' };
    }
    case 'DEFERRED':
      return { tone: 'warn', label: 'DEFERRED', runtime: 'waiting' };
    case 'ACCEPTED':
    case 'ADMITTED':
    case 'REDIRECTED':
      return { tone: 'info', label: r.state, runtime: 'waiting' };
    default:
      // PROPOSED / QUEUED and anything unexpected: pending, neutral tone.
      return { tone: '', label: r.state, runtime: 'waiting' };
  }
}

/** A budget fraction, or null when no ceiling was configured (never invented). */
function fraction(used: number, cap: number): number | null {
  if (!(cap > 0)) return null;
  return Math.min(1, used / cap);
}

export interface GuardLevel {
  level: 'ok' | 'warn' | 'risk';
  text: string;
}

function levelFor(ratio: number | null): GuardLevel['level'] {
  if (ratio === null) return 'ok';
  if (ratio >= 0.95) return 'risk';
  if (ratio >= 0.7) return 'warn';
  return 'ok';
}

/** Execution-lease guard: only meaningful for an IN_FLIGHT task. */
export function leaseGuard(r: CoordinationRequest, now: string): GuardLevel | null {
  if (r.state !== 'IN_FLIGHT') return null;
  const quietMs = minutesAgo(now, r.updatedAt) * 1000;
  const owner = r.execOwner ?? 'unassigned';
  if (!r.execOwner) return { level: 'risk', text: 'lease lost' };
  if (quietMs < 60_000) return { level: 'ok', text: `lease held · ${owner}` };
  if (quietMs < 120_000) return { level: 'warn', text: `lease ageing · ${owner}` };
  return { level: 'risk', text: `lease stale · ${owner}` };
}

/** Spend guard against the request's own bid ceiling. */
export function budgetGuard(r: CoordinationRequest): { dollars: GuardLevel | null; tokens: GuardLevel | null } {
  const dollarRatio = fraction(r.spent.dollars, r.bid.dollars);
  const tokenRatio = fraction(r.spent.tokens, r.bid.tokens);
  const fmtDollar = `$${r.spent.dollars.toFixed(2)}${r.bid.dollars > 0 ? ` / $${r.bid.dollars.toFixed(2)}` : ''}`;
  const fmtToken = `${r.spent.tokens.toLocaleString()}${r.bid.tokens > 0 ? ` / ${r.bid.tokens.toLocaleString()}` : ''} tok`;
  return {
    dollars: dollarRatio === null && r.bid.dollars <= 0 ? null : { level: levelFor(dollarRatio), text: fmtDollar },
    tokens: tokenRatio === null && r.bid.tokens <= 0 ? null : { level: levelFor(tokenRatio), text: fmtToken },
  };
}

/** One node of the agent tree: the primary agent is depth 0, children below. */
export interface AgentNode {
  request: CoordinationRequest;
  depth: number;
  status: DerivedStatus;
  /** Direct children (decomposition sub-agents). */
  children: AgentNode[];
}

/** Max tree depth we render; deeper chains collapse to a count. */
const MAX_TREE_DEPTH = 4;

function buildNode(
  r: CoordinationRequest,
  depth: number,
  byParent: Map<string, CoordinationRequest[]>,
  seen: Set<string>,
): AgentNode {
  const childrenReq = depth < MAX_TREE_DEPTH && !seen.has(r.id) ? (byParent.get(r.id) ?? []) : [];
  const nextSeen = new Set(seen);
  nextSeen.add(r.id);
  return {
    request: r,
    depth,
    status: deriveStatus(r, ''),
    children: childrenReq.map((c) => buildNode(c, depth + 1, byParent, nextSeen)),
  };
}

/** A task row and everything the list/detail views need to render it. */
export interface AgentTask {
  request: CoordinationRequest;
  status: DerivedStatus;
  /** Decomposition sub-agents (mechanism B). */
  subAgents: AgentNode[];
  subAgentCount: number;
  /** Swarm hop scopes (mechanism C), from hop_chain — a flat chain, not a tree. */
  swarmChain: string[];
  totalTokens: number;
  relativeAge: string;
}

function countSub(node: AgentNode): number {
  return node.children.reduce((s, c) => s + 1 + countSub(c), 0);
}

/** Relative age ("just now", "4m", "3h", "2d") from a `now` instant. */
export function relAge(now: string, iso: string): string {
  const sec = Math.max(0, (Date.parse(now) - Date.parse(iso)) / 1000);
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86_400)}d ago`;
}

function indexByParent(requests: CoordinationRequest[]): Map<string, CoordinationRequest[]> {
  const map = new Map<string, CoordinationRequest[]>();
  for (const r of requests) {
    if (!r.parentRequestId) continue;
    const arr = map.get(r.parentRequestId);
    if (arr) arr.push(r);
    else map.set(r.parentRequestId, [r]);
  }
  for (const arr of map.values())
    arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return map;
}

/** Recursively recompute each node's status against the real `now`. */
function retimestamp(node: AgentNode, now: string, byParent: Map<string, CoordinationRequest[]>): AgentNode {
  const reqChildren = byParent.get(node.request.id) ?? [];
  return {
    request: node.request,
    depth: node.depth,
    status: deriveStatus(node.request, now),
    children: reqChildren.map((c) =>
      retimestamp(buildNode(c, node.depth + 1, byParent, new Set([node.request.id])), now, byParent),
    ),
  };
}

/** Build one task view-model rooted at `r`, resolving its subtree in-memory. */
function makeTask(r: CoordinationRequest, byParent: Map<string, CoordinationRequest[]>, now: string): AgentTask {
  const status = deriveStatus(r, now);
  const childReqs = byParent.get(r.id) ?? [];
  const nodes: AgentNode[] = childReqs.map((c) =>
    retimestamp(buildNode(c, 1, byParent, new Set([r.id])), now, byParent),
  );
  const subAgentCount = nodes.reduce((s, n) => s + 1 + countSub(n), 0);
  // hop_chain records the origin scopes traversed; drop the task's own
  // target so the rail shows the path, not the endpoint twice.
  const swarmChain = r.hopChain.filter((s) => s && s !== r.targetScope);
  return {
    request: r,
    status,
    subAgents: nodes,
    subAgentCount,
    swarmChain,
    totalTokens: r.spent.tokens,
    relativeAge: relAge(now, r.updatedAt),
  };
}

/**
 * Turn the raw request set into task view-models. The `requests` argument is
 * the tenant's full request list (from `coord.list`) so children resolve
 * in-memory without per-row queries; the result is the non-terminal REQUESTs,
 * newest activity first.
 */
export function buildTasks(requests: CoordinationRequest[], now: string): AgentTask[] {
  const byParent = indexByParent(requests);
  const activeIds = new Set(
    requests.filter((r) => r.messageClass === 'REQUEST' && !TERMINAL_STATES.has(r.state)).map((r) => r.id),
  );
  const roots = requests.filter(
    (r) =>
      r.messageClass === 'REQUEST' &&
      !TERMINAL_STATES.has(r.state) &&
      // A child of another still-active task renders inside that task's tree,
      // so only true roots head the list.
      (!r.parentRequestId || !activeIds.has(r.parentRequestId)),
  );
  return roots
    .map((r) => makeTask(r, byParent, now))
    .sort((a, b) => b.request.updatedAt.localeCompare(a.request.updatedAt) || a.request.id.localeCompare(b.request.id));
}

/**
 * A single task view-model for any request id (used by the detail page, which
 * may open on a sub-agent or a task that just settled). Returns null when the
 * id is unknown to the set.
 */
export function taskFor(requests: CoordinationRequest[], id: string, now: string): AgentTask | null {
  const req = requests.find((r) => r.id === id);
  if (!req) return null;
  return makeTask(req, indexByParent(requests), now);
}

/** Aggregate counts for the header KPI tiles + LIVE pill. */
export interface TaskTotals {
  running: number;
  waiting: number;
  needsAttention: number;
  tokensToday: number;
  anyLive: boolean;
}

export function taskTotals(tasks: AgentTask[]): TaskTotals {
  let running = 0;
  let waiting = 0;
  let needsAttention = 0;
  let tokensToday = 0;
  for (const t of tasks) {
    if (t.status.runtime === 'processing') running++;
    else if (t.status.runtime === 'risk') needsAttention++;
    else waiting++;
    tokensToday += t.totalTokens;
  }
  return {
    running,
    waiting,
    needsAttention,
    tokensToday,
    anyLive: tasks.some((t) => t.status.runtime === 'processing'),
  };
}

/* ─────────────────────────────────────────────── HTML fragments ─────────── */

function badge(status: DerivedStatus, live: boolean): string {
  // The pulse dot only reads as "moving" for a live-ish status; a terminal or
  // plainly-queued row keeps a static dot.
  const pulse = (status.tone === 'info' || status.runtime === 'processing') && live;
  return statusChip(status.label, { tone: toneOf(status.tone), pulse });
}

/** One audit row as a timeline item — the same shape the detail view renders. */
export function taskFeedItem(
  e: { action: string; actor: string; detail: string; at: string },
  now: string,
): TimelineItem {
  return { title: e.action, detail: e.detail, time: relAge(now, e.at) };
}

/** What the feed says before anything has happened. One copy: the server renders
 * it and the poll payload carries it, so the poller cannot drift from the page. */
export const TASK_FEED_EMPTY = '<p class="v-meta">No activity recorded for this task yet.</p>';

function dotFor(status: DerivedStatus): string {
  return `<span class="v-agent-dot" data-state="${status.runtime}" aria-hidden="true"></span>`;
}

function guardStripHtml(task: AgentTask, now: string): string {
  const lease = leaseGuard(task.request, now);
  const budget = budgetGuard(task.request);
  const chips: string[] = [];
  if (lease)
    chips.push(
      `<span class="v-guard" data-state="${lease.level}"><span class="v-guard__k">lease</span> ${esc(lease.text)}</span>`,
    );
  if (budget.dollars)
    chips.push(
      `<span class="v-guard" data-state="${budget.dollars.level}"><span class="v-guard__k">spend</span> ${esc(budget.dollars.text)}</span>`,
    );
  if (budget.tokens)
    chips.push(
      `<span class="v-guard" data-state="${budget.tokens.level}"><span class="v-guard__k">tokens</span> ${esc(budget.tokens.text)}</span>`,
    );
  return `<div class="v-guardstrip">${chips.join('')}</div>`;
}

function progressToneCls(level: GuardLevel['level'] | undefined): string {
  if (level === 'risk') return ' v-progress-risk';
  if (level === 'warn') return ' v-progress-warn';
  return '';
}

function renderNode(node: AgentNode, now: string, here: string): string {
  const r = node.request;
  const depthCls = node.depth > 1 ? ` v-agent-tree-row--depth-${Math.min(node.depth, MAX_TREE_DEPTH)}` : '';
  const budget = budgetGuard(r);
  const pct = budget.tokens ? Math.round((fraction(r.spent.tokens, r.bid.tokens) ?? 0) * 100) : null;
  const toneCls = budget.tokens ? progressToneCls(budget.tokens.level) : '';
  const bar =
    pct === null
      ? ''
      : `<div class="v-progress v-progress--hatch${toneCls}" style="max-width:120px" role="img" aria-label="token budget ${pct}% used"><i style="width:${pct}%"></i></div>`;
  return `<div class="v-agent-tree-row${depthCls}${node.status.runtime === 'processing' ? ' is-active' : ''}">
  ${dotFor(node.status)}
  <div class="v-agent-tree-main">
    <a class="v-strong" href="${esc(withReturnTo(requestDetailUrl(r.id), here))}">${esc(r.targetScope || r.id)}</a>
    <span class="v-agent-tree-goal">${esc(r.goal)}</span>
  </div>
  ${badge(node.status, node.status.runtime === 'processing')}
  ${bar}
</div>
${node.children.map((c) => renderNode(c, now, here)).join('')}`;
}

function renderSwarmChain(task: AgentTask): string {
  if (task.swarmChain.length === 0) return '';
  const hops = task.swarmChain
    .map(
      (s, i) =>
        `<span class="v-swarm-hop">${esc(s)}</span>${i < task.swarmChain.length - 1 ? '<span class="v-swarm-sep" aria-hidden="true">→</span>' : ''}`,
    )
    .join('');
  return `<div class="v-swarm-chain" title="Swarm deliberation chain (hop_chain): unparented handoffs, not sub-agents">
  <span class="v-swarm-label">swarm</span>${hops}</div>`;
}

/**
 * What a task's code review looks like from here: its state, and nothing else.
 *
 * A review is keyed by mission id and a task is keyed by request id, so the only
 * honest link between them is the one a reader makes: the id offered as the
 * review's key. The row offers it, and says whether a review is already open
 * under it — the page itself is the one that explains what a review is.
 */
export interface ReviewLink {
  status: string;
  updatedAt: string;
}

/** The review affordance for one task: open it, or open one under this id. */
function reviewActionHtml(requestId: string, review: ReviewLink | undefined): string {
  const href = `/console/review/${encodeURIComponent(requestId)}`;
  if (!review) {
    return `<a class="v-btn v-btn-secondary v-btn-sm" href="${esc(href)}" title="No review is open under this task's id">Review change set →</a>`;
  }
  // The same chip the review index prints for this status, from the same map:
  // a task row and the page it opens cannot disagree about the colour of
  // "CHANGES_REQUESTED". The status and the review's age stay in the tooltip.
  return `${statusChip(`review · ${review.status}`, {
    tone: reviewTone(review.status),
    title: `Review ${review.status} — updated ${review.updatedAt}`,
  })} <a class="v-btn v-btn-secondary v-btn-sm" href="${esc(href)}">Open review →</a>`;
}

/** One expandable list row. Uses <details name="v-tasks"> so only one opens. */
export function renderTaskRow(
  task: AgentTask,
  now: string,
  here: string,
  review?: ReviewLink,
  /**
   * Open this task in the shared inspector instead of leaving the list. Absent
   * on surfaces with no inspector layout, where the title keeps linking to the
   * record — one renderer, two honest behaviours, decided by the caller.
   */
  inspectHref?: (requestId: string) => string,
): string {
  const r = task.request;
  const live = task.status.runtime === 'processing';
  const subLabel =
    task.subAgentCount > 0
      ? `<span class="v-task-count" title="Decomposition sub-agents">↳ ${task.subAgentCount} sub-agent${task.subAgentCount === 1 ? '' : 's'}</span>`
      : '';
  const swarmLabel =
    task.swarmChain.length > 0
      ? `<span class="v-task-count" title="Swarm hops (hop_chain)">⇢ ${task.swarmChain.length} hop${task.swarmChain.length === 1 ? '' : 's'}</span>`
      : '';
  const tokens = `<span class="v-num v-meta">${task.totalTokens.toLocaleString()} tok</span>`;
  return `<details class="v-task-row" name="v-tasks" id="task-${esc(r.id)}">
  <summary class="v-task-row-head">
    <div class="v-task-status">${badge(task.status, live)}</div>
    <div class="v-task-main">
      ${
        inspectHref
          ? `<a class="v-strong v-truncate" href="${esc(inspectHref(r.id))}" data-inspect="${esc(`request:${r.id}`)}">${esc(r.goal)}</a>`
          : `<a class="v-strong v-truncate" href="${esc(withReturnTo(requestDetailUrl(r.id), here))}">${esc(r.goal)}</a>`
      }
      <div class="v-task-side">
        <span class="v-mono v-meta">${esc(r.originScope)}→${esc(r.targetScope)}</span>
        ${subLabel}${swarmLabel}${tokens}
        <span class="v-meta" data-age="${esc(r.updatedAt)}">${esc(task.relativeAge)}</span>
      </div>
    </div>
  </summary>
  <div class="v-task-detail">
    ${guardStripHtml(task, now)}
    ${renderSwarmChain(task)}
    <div class="v-agent-tree">
      <div class="v-agent-tree-row v-agent-tree-row--primary">
        ${dotFor(task.status)}
        <div class="v-agent-tree-main"><span class="v-strong">${esc(r.targetScope || r.id)}</span> <span class="v-meta">primary agent</span></div>
        ${badge(task.status, live)}
      </div>
      ${task.subAgents.map((n) => renderNode(n, now, here)).join('') || '<p class="v-meta" style="padding:8px 0 0 22px">no sub-agents</p>'}
    </div>
    <div class="v-task-detail-actions">
      <a class="v-btn v-btn-secondary v-btn-sm" href="${esc(withReturnTo(`/console/agent-tasks/${encodeURIComponent(r.id)}`, here))}">Open live view →</a>
      ${reviewActionHtml(r.id, review)}
    </div>
  </div>
</details>`;
}

function kpiTile(label: string, value: string, tone: string, glyph: string): string {
  return `<div class="v-card v-kpi-card">
  <div class="v-kpi-label"><span aria-hidden="true">${glyph}</span>${esc(label)}</div>
  <div class="v-kpi" data-kpi="${esc(tone)}">${esc(value)}</div>
</div>`;
}

export function renderKpiTiles(totals: TaskTotals): string {
  return `<div class="v-grid">
  ${kpiTile('Running', String(totals.running), 'running', '▶')}
  ${kpiTile('Waiting', String(totals.waiting), 'waiting', '⏸')}
  ${kpiTile('Needs attention', String(totals.needsAttention), 'attention', '!')}
  ${kpiTile('Tokens in flight', totals.tokensToday.toLocaleString(), 'tokens', '⚡')}
</div>`;
}

export function renderLivePill(anyLive: boolean): string {
  return `<span class="v-live" data-state="${anyLive ? 'live' : 'idle'}" id="v-agent-live">
  <span class="v-live-dot" aria-hidden="true"></span>${anyLive ? 'LIVE' : 'IDLE'}</span>`;
}

/** The list page body (LIVE pill + KPIs + expandable rows). Inside renderListPage. */
export function renderAgentTaskList(
  tasks: AgentTask[],
  totals: TaskTotals,
  now: string,
  here: string,
  reviews: ReadonlyMap<string, ReviewLink> = new Map(),
  /** See `renderTaskRow`: supplied by the route when it can host a panel. */
  inspectHref?: (requestId: string) => string,
): string {
  const rows = tasks.map((t) => renderTaskRow(t, now, here, reviews.get(t.request.id), inspectHref)).join('');
  return `<div class="v-task-list" data-now="${esc(now)}">
  <div class="v-split" style="margin-bottom:14px;">
    <p class="v-lede" style="margin:0">Real-time view of Jcode coding-agent executions in flight. Expand a task to see its agents.</p>
    ${renderLivePill(totals.anyLive)}
  </div>
  ${renderKpiTiles(totals)}
  ${
    rows
      ? `<div class="v-tasks">${rows}</div>`
      : emptyState({
          title: 'No ongoing tasks',
          body: 'No coding-agent execution is currently in the pipeline. A task appears here as soon as a request is admitted to an agent.',
          actions: ['<a class="v-btn v-btn-secondary v-btn-sm" href="/console/requests">Browse requests</a>'],
        })
  }
</div>`;
}

/** The dedicated live detail view body (guard strip + tree + chain + feed). */
export function renderAgentTaskDetail(
  task: AgentTask,
  feed: { action: string; actor: string; detail: string; at: string }[],
  now: string,
  here: string,
  review?: ReviewLink,
): string {
  const r = task.request;
  const feedHtml = timeline(
    feed.map((e) => taskFeedItem(e, now)),
    { empty: TASK_FEED_EMPTY },
  );
  return `${pageHeader({
    eyebrow: 'Agent task',
    title: r.goal,
    actions: renderLivePill(task.status.runtime === 'processing'),
  })}
<div class="v-task-side" style="margin:-8px 0 0;">
  ${badge(task.status, task.status.runtime === 'processing')}
  <span class="v-mono v-meta">${esc(r.id)}</span>
  <span class="v-meta">${esc(r.originScope)}→${esc(r.targetScope)}</span>
  <span class="v-meta">updated ${esc(task.relativeAge)}</span>
</div>
<div class="v-grid-wide" style="margin-top:16px;">
  <div class="v-stack">
    ${guardStripHtml(task, now)}
    ${renderSwarmChain(task)}
    <section class="v-card v-card-flush"><div style="padding:18px 20px;">
      ${sectionHeader({ title: 'Live feed', sub: 'Runtime actions recorded against this task, newest last.' })}
      <div id="v-agent-feed" data-request="${esc(r.id)}">${feedHtml}</div>
    </div></section>
  </div>
  <div class="v-stack">
    <section class="v-card v-card-flush"><div style="padding:18px 20px;">
      ${sectionHeader({ title: 'Agents', sub: task.subAgents.length ? `${task.subAgents.length} sub-agent(s) below the primary.` : undefined })}
      <div class="v-agent-tree">
        <div class="v-agent-tree-row v-agent-tree-row--primary">
          ${dotFor(task.status)}
          <div class="v-agent-tree-main"><span class="v-strong">${esc(r.targetScope || r.id)}</span> <span class="v-meta">primary</span></div>
          ${badge(task.status, task.status.runtime === 'processing')}
        </div>
        ${task.subAgents.map((n) => renderNode(n, now, here)).join('') || '<p class="v-meta" style="padding:8px 0 0 22px">no sub-agents</p>'}
      </div>
    </div></section>
    <section class="v-card v-card-flush"><div style="padding:18px 20px;">
      ${sectionHeader({
        title: 'Code review',
        sub: review
          ? `A review is open under this task's id — ${review.status}, updated ${review.updatedAt}. Changes are decided hunk by hunk, and a VERIFIED snapshot is created only after review and verification pass.`
          : 'No review is open under this task\u2019s id. A review compares a working tree against a git baseline and gates the change hunk by hunk, with a secret scan before any snapshot.',
      })}
      <div style="display:flex;gap:8px;flex-wrap:wrap;">${reviewActionHtml(r.id, review)}</div>
    </div></section>
    <a class="v-btn v-btn-secondary v-btn-sm" href="${esc(requestDetailUrl(r.id))}">Full request record →</a>
  </div>
</div>`;
}

/** JSON snapshot for the poll fast-follow (see route `?format=json`). */
export function snapshotTasks(tasks: AgentTask[]): unknown {
  return {
    now: new Date().toISOString(),
    totals: taskTotals(tasks),
    tasks: tasks.map((t) => ({
      id: t.request.id,
      goal: t.request.goal,
      state: t.status.label,
      runtime: t.status.runtime,
      tone: t.status.tone,
      origin: t.request.originScope,
      target: t.request.targetScope,
      subAgents: t.subAgentCount,
      swarmHops: t.swarmChain.length,
      tokens: t.totalTokens,
      updatedAt: t.request.updatedAt,
    })),
  };
}
