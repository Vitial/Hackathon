// Feed — the ranked attention model behind `/console/inbox`.
//
// The question this answers is "what needs a human now?", and it answers it from
// reads that already existed: the request rows the coordinator admits and
// settles, and the claim rows the ledger curates. There is deliberately **no
// second store** here — no notifications table, no read-state column, no
// `feed_items` view. A notification that exists only to make this page look
// complete is the exact fabrication the repo's copy law forbids (design.md
// "Copy honesty", test/fabrication-guard.test.ts).
//
// Three sources, and only three, because only three have a real read today:
//
//   decision  an ADMITTED REQUEST that bid human minutes and is waiting on a
//             person. The predicate is `awaitingHumanReview` from review.ts —
//             the *same* function the approval queue filters with, so the Feed
//             can never claim a different queue than the one it links to.
//   blocked   a settled request that did not deliver: DENIED, FAILED,
//             TERMINATED_BUDGET, EXPIRED. (A refusal is not a state of its own:
//             the coordinator preserves it as FAILED with a `REFUSAL|` reason,
//             or DENIED at admission, so it lands in these four rows.)
//   evidence  a claim the ledger marks DISPUTED or STALE — a contradiction in
//             flight, or evidence past its validity window.
//
// Deliberately absent: mentions, unread state, "assigned to me", saved views.
// Each needs a durable read-state or subscription contract that does not exist,
// and inventing one here would put a number on the page that no row backs.
//
// Ranking is explicit and cheap: kind first (a decision blocks a person; a
// stale claim only misleads), then oldest first inside a kind, because aging is
// the harm. The list is capped, and it says how many it withheld rather than
// implying it showed everything.

import type { AsyncDb } from '../core/db.ts';
import type { Coordinator } from '../coord/coordinator.ts';
import type { CoordinationRequest } from '../core/types.ts';
import { awaitingHumanReview } from './review.ts';
import { emptyState, pageHeader, statusChip, type Tone } from './components.ts';
import { searchClaims, type ClaimSummary } from './report.ts';
import { claimDetailUrl, esc, requestDetailUrl, withReturnTo } from './render.ts';
import {
  claimPanel,
  hrefWithoutInspect,
  inspectHref,
  inspectKey,
  inspectTable,
  parseInspect,
  renderInspectLayout,
  requestPanel,
  unavailablePanel,
  type InspectTarget,
  type InspectorPanel,
} from './inspector.ts';

/** Items shown before the feed says what it withheld. */
export const FEED_LIMIT = 40;

/** How many claim rows the evidence read considers before the cap applies. */
const EVIDENCE_LIMIT = 200;

export type FeedKind = 'decision' | 'blocked' | 'evidence';

/** A request state that means "someone should look at why this did not land". */
const BLOCKED_WHY: Record<string, string> = {
  DENIED: 'Denied at admission.',
  FAILED: 'Execution failed or was refused.',
  TERMINATED_BUDGET: 'Halted on budget.',
  EXPIRED: 'Expired without a delivered outcome.',
};

/** Ledger states that mean the evidence itself is in question. */
const EVIDENCE_WHY: Record<string, string> = {
  DISPUTED: 'A contradiction on this claim is unresolved.',
  STALE: 'Past its validity window, or superseded by a newer source.',
};

export interface FeedItem {
  kind: FeedKind;
  /** Stable identity across renders: kind + record id. */
  id: string;
  recordId: string;
  record: 'Request' | 'Claim';
  /** The record's own state or status, verbatim — never a rewritten label. */
  state: string;
  title: string;
  /** Why this is in the feed. One sentence, true of the row it sits on. */
  why: string;
  /** The authoritative record. The feed never becomes the source of record. */
  href: string;
  scope: string | null;
  /** Minutes since the record was created; null when the timestamp is unreadable. */
  ageMinutes: number | null;
  /** 0 = most urgent. Position in the ranked, capped list. */
  rank: number;
}

export interface FeedModel {
  items: FeedItem[];
  /** Items the cap withheld, so the page can say so instead of implying "all". */
  omitted: number;
  /** Every item considered, before the cap. */
  considered: number;
  /** Real per-kind totals (pre-cap), for the filter tabs. */
  counts: Record<FeedKind, number>;
  /** The reads this model performed. Printed so the page never implies more. */
  sources: string[];
  /**
   * Every considered item by `kind:id`, including the ones the cap withheld — a
   * deep link must be able to open an item the current page happens not to list.
   */
  byTarget: Record<string, FeedItem>;
  /** The request rows this model read, by id. The inspector's source data. */
  requests: Record<string, CoordinationRequest>;
  /** The claim rows this model read, by id. */
  claims: Record<string, ClaimSummary>;
}

export interface FeedOptions {
  db: AsyncDb;
  coord: Coordinator;
  tenant: string;
  /** Server clock for this request, already sampled. */
  at: string;
  /** Where a detail link should return to (this page, with its filters). */
  here: string;
}

/** Minutes between two ISO timestamps, or null when either will not parse. */
function ageMinutesSince(createdAt: string, at: string): number | null {
  const created = Date.parse(createdAt);
  const now = Date.parse(at);
  if (!Number.isFinite(created) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - created) / 60_000));
}

/** Human age: minutes, hours, days. `—` when the timestamp is unreadable. */
export function fmtAge(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}

/** Request rows, oldest first. The coordinator returns them in creation order. */
function requestItems(
  requests: CoordinationRequest[],
  at: string,
  here: string,
): { decisions: FeedItem[]; blocked: FeedItem[] } {
  const decisions: FeedItem[] = [];
  const blocked: FeedItem[] = [];
  for (const r of requests) {
    if (awaitingHumanReview(r)) {
      decisions.push({
        kind: 'decision',
        id: `decision:${r.id}`,
        recordId: r.id,
        record: 'Request',
        state: r.state,
        title: r.goal,
        why: `Waiting on a human decision, with ${r.bid.humanMinutes} human minute(s) bid.`,
        href: withReturnTo(requestDetailUrl(r.id), here),
        scope: r.targetScope || r.originScope || null,
        ageMinutes: ageMinutesSince(r.createdAt, at),
        rank: 0,
      });
      continue;
    }
    const why = BLOCKED_WHY[r.state];
    if (why) {
      blocked.push({
        kind: 'blocked',
        id: `blocked:${r.id}`,
        recordId: r.id,
        record: 'Request',
        state: r.state,
        title: r.goal,
        why,
        href: withReturnTo(requestDetailUrl(r.id), here),
        scope: r.targetScope || r.originScope || null,
        ageMinutes: ageMinutesSince(r.createdAt, at),
        rank: 0,
      });
    }
  }
  return { decisions, blocked };
}

/** The claim rows behind the evidence items — read once, used twice. */
async function evidenceRows(opts: FeedOptions): Promise<ClaimSummary[]> {
  const statuses = Object.keys(EVIDENCE_WHY);
  const page = await searchClaims(opts.db, opts.tenant, { statuses, limit: EVIDENCE_LIMIT, order: 'asc' });
  return page.rows;
}

/** Evidence items for the claim rows already read. */
function evidenceItems(opts: FeedOptions, rows: ClaimSummary[]): FeedItem[] {
  return rows.map((c) => ({
    kind: 'evidence' as const,
    id: `evidence:${c.id}`,
    recordId: c.id,
    record: 'Claim' as const,
    state: c.status,
    title: c.subject,
    why: EVIDENCE_WHY[c.status] ?? `Status ${c.status}.`,
    href: withReturnTo(claimDetailUrl(c.id), opts.here),
    scope: c.scope || null,
    ageMinutes: ageMinutesSince(c.createdAt, opts.at),
    rank: 0,
  }));
}

/**
 * Build the feed. Two reads, whatever the tenant's size: one pass over the
 * request rows and one filtered page of claims. Nothing here loops over rooms
 * or records, which is what keeps the page's cost flat as the tenant grows.
 */
export async function buildFeed(opts: FeedOptions): Promise<FeedModel> {
  const requestRows = await opts.coord.list(opts.tenant);
  const { decisions, blocked } = requestItems(requestRows, opts.at, opts.here);
  // One claim read for the page: the same rows feed the items and the panel.
  const claimRows = await evidenceRows(opts);
  const evidence = evidenceItems(opts, claimRows);

  const counts: Record<FeedKind, number> = {
    decision: decisions.length,
    blocked: blocked.length,
    evidence: evidence.length,
  };

  // Oldest first inside a kind: an item that has waited longer is more urgent.
  const byAge = (a: FeedItem, b: FeedItem): number => {
    if (a.ageMinutes === null && b.ageMinutes === null) return a.id.localeCompare(b.id);
    if (a.ageMinutes === null) return 1;
    if (b.ageMinutes === null) return -1;
    return b.ageMinutes - a.ageMinutes || a.id.localeCompare(b.id);
  };
  // Kind order is the concatenation order — a person waiting for a decision
  // outranks a settled failure, which outranks evidence that is merely soft.
  // Within a kind, oldest first.
  const ranked = [...decisions.sort(byAge), ...blocked.sort(byAge), ...evidence.sort(byAge)].map((item, i) => ({
    ...item,
    rank: i,
  }));

  const considered = ranked.length;
  const items = ranked.slice(0, FEED_LIMIT);
  const byTarget: Record<string, FeedItem> = {};
  for (const item of ranked) byTarget[`${item.kind === 'evidence' ? 'claim' : 'request'}:${item.recordId}`] = item;
  return {
    items,
    omitted: considered - items.length,
    considered,
    counts,
    sources: ['requests', 'claims'],
    byTarget,
    requests: Object.fromEntries(requestRows.map((r) => [r.id, r])),
    claims: Object.fromEntries(claimRows.map((c) => [c.id, c])),
  };
}

/** Filter tabs. Each one is a real filter over the model above — no other kind. */
export const FEED_TABS: ReadonlyArray<{ key: 'all' | FeedKind; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'decision', label: 'Decisions' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'evidence', label: 'Evidence' },
];

/** `?view=` is validated against the tab set, so an unknown filter shows All. */
export function resolveFeedTab(view: string | null): 'all' | FeedKind {
  const found = FEED_TABS.find((t) => t.key === view);
  return found ? found.key : 'all';
}

const KIND_LABEL: Record<FeedKind, string> = {
  decision: 'Decision',
  blocked: 'Blocked',
  evidence: 'Evidence',
};

/** Which of the three the item is. The tones are the shared ones: a blocked
 * request is the same red here as it is in a list cell or a panel. */
const KIND_TONE: Record<FeedKind, Tone> = {
  decision: 'warn',
  blocked: 'risk',
  evidence: 'info',
};

export interface FeedPageOptions {
  model: FeedModel;
  tab: 'all' | FeedKind;
  /** This page's path, so the inspector's deep links keep its filters. */
  path?: string;
  /** This page's query string, filters and all. */
  search?: string;
  /** The selection from `?inspect=`, already parsed. */
  inspect?: InspectTarget | null;
  /** Server clock, for the panel's ages. */
  at?: string;
}

/**
 * The panel for a selection: the record the row pointed at, or an honest
 * "not in this view" when the deep link names something the filters exclude.
 */
export function feedPanel(model: FeedModel, target: InspectTarget, opts: { at: string; here: string }): InspectorPanel {
  if (target.kind === 'request') {
    const r = model.requests[target.id];
    if (!r) return unavailablePanel(target, 'This request is not among the rows this page read.');
    const item = model.byTarget[inspectKey(target)];
    return requestPanel(r, {
      at: opts.at,
      summary: item?.why,
      recordHref: withReturnTo(requestDetailUrl(r.id), opts.here),
      buzzHref:
        r.targetScope || r.originScope ? `/console/buzz/${encodeURIComponent(r.targetScope || r.originScope)}` : null,
    });
  }
  if (target.kind === 'claim') {
    const c = model.claims[target.id];
    if (!c) return unavailablePanel(target, 'This claim is not among the rows this page read.');
    return claimPanel(c, {
      at: opts.at,
      summary: model.byTarget[inspectKey(target)]?.why,
      recordHref: withReturnTo(claimDetailUrl(c.id), opts.here),
      buzzHref: c.scope ? `/console/buzz/${encodeURIComponent(c.scope)}` : null,
    });
  }
  return unavailablePanel(target, 'This page does not render that kind of record.');
}

/**
 * The Inbox page body. A table, because every column here is a fact about the
 * row: what it is, why it needs attention, where it lives, how long it has
 * waited, and the two places it can be acted on.
 */
export function renderFeedPage(opts: FeedPageOptions): string {
  const { model, tab, path = '/console/inbox', search = '', inspect = null, at = '' } = opts;
  const shown = tab === 'all' ? model.items : model.items.filter((i) => i.kind === tab);
  const closeHref = hrefWithoutInspect(path, search);
  const hrefFor = (target: InspectTarget): string => inspectHref(path, search, target);

  const tabs = `<nav class="v-segmented" aria-label="Feed filter">${FEED_TABS.map((t) => {
    const n =
      t.key === 'all' ? model.counts.decision + model.counts.blocked + model.counts.evidence : model.counts[t.key];
    // A zero count renders as nothing: a badge that says 0 is decoration, and
    // the tab itself already means "none of these".
    const label = `${esc(t.label)}${n > 0 ? ` <span class="v-mono" style="font-size:11px;">${n}</span>` : ''}`;
    const href = t.key === 'all' ? '/console/inbox' : `/console/inbox?view=${t.key}`;
    return `<a href="${esc(href)}"${t.key === tab ? ' aria-current="page"' : ''}>${label}</a>`;
  }).join('')}</nav>`;
  const rows = shown.map((i) => ({
    target: { kind: i.kind === 'evidence' ? ('claim' as const) : ('request' as const), id: i.recordId },
    title: i.title,
    sub: i.recordId,
    cells: [
      `${statusChip(KIND_LABEL[i.kind], { tone: KIND_TONE[i.kind], dot: false })} <span class="v-mono v-meta">${esc(i.state)}</span>`,
      esc(i.why),
      i.scope
        ? `<a class="v-mono v-meta" href="${esc(`/console/buzz/${encodeURIComponent(i.scope)}`)}">#${esc(i.scope)}</a>`
        : '<span class="v-meta">—</span>',
      `<span class="v-num v-meta">${esc(fmtAge(i.ageMinutes))}</span>`,
    ],
  }));

  const body = shown.length
    ? inspectTable(['Item', 'Kind', 'Why it is here', 'Where', 'Waiting'], rows, hrefFor)
    : emptyState({
        title: 'Nothing in this filter needs attention',
        body: 'The feed reads requests awaiting a human decision, requests that were denied, failed, halted or expired, and claims marked disputed or stale. An empty feed means none of those exist right now — not that the reads failed.',
        note: 'Switch to All to see every kind at once, or go straight to a record list:',
        actions: [
          '<a class="v-btn v-btn-secondary v-btn-sm" href="/console/human-work">Open the approval queue</a>',
          '<a class="v-btn v-btn-secondary v-btn-sm" href="/console/requests">Browse requests</a>',
          '<a class="v-btn v-btn-secondary v-btn-sm" href="/console/claims">Browse claims</a>',
        ],
      });

  const countLine =
    model.considered === 0
      ? 'No items need attention.'
      : `${model.considered} item(s) need attention · showing ${shown.length}${
          model.omitted > 0
            ? ` · ${model.omitted} more withheld by the ${FEED_LIMIT}-item cap — pick a filter or open the record list`
            : ''
        }`;

  const page = `${pageHeader({
    eyebrow: 'Feed',
    title: 'Inbox',
    sub: 'Ranked attention: the work that is waiting on a person, and the evidence that is in question. Selecting an item opens its context beside this list; the record itself stays authoritative.',
    actions: tabs,
    count: `${countLine} · read live from ${model.sources.join(' and ')}`,
  })}
${body}`;

  return renderInspectLayout({
    inner: page,
    panel: inspect ? feedPanel(model, inspect, { at, here: closeHref }) : null,
    closeHref,
    label: 'Feed item context',
  });
}

/** Re-exported so the route parses `?inspect=` exactly the way this page links it. */
export { parseInspect };
