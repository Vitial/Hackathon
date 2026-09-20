// Buzz record context — the records a room's conversation links to.
//
// The contract (redesign.md §8.2, §10 Phase 6):
//
//   * the panel states what *this conversation already references*. The
//     references are read from the messages the room has already loaded, so
//     there is no record-link table, no tagging UI and no second copy of a
//     record: what the panel shows is exactly what someone pasted into the
//     room;
//   * it is Buzz chrome. Everything here is `buzz-*` drawn from Buzz's own
//     `--buzz-*` ramp, and this module imports no Console chrome: the surface
//     split (design.md, `test/buzz-chat-first.test.ts`) is a contract, not a
//     preference;
//   * one read per kind, batched by id, and **no reads at all when nothing is
//     linked**. A digest must not cost one statement per record, and a room
//     with no links must not pay for the panel;
//   * a reference the viewer may not read keeps its link and states that the
//     context is unavailable. The reference came from a message they can
//     already read, so hiding it would make the panel disagree with the
//     conversation above it — and inventing fields would be worse than both.
//
// What this is not: the Console inspector. That is a two-column layout in
// Console chrome with Console tokens; this is a room's own reading of its own
// conversation, and its exits are links into the Console.

import type { AsyncDb } from '../core/db.ts';
import { searchClaims, searchRequests } from './report.ts';
import { getIssuesByIds } from './issues.ts';

export type BuzzRecordKind = 'request' | 'claim' | 'issue';

export interface BuzzRecordRef {
  kind: BuzzRecordKind;
  id: string;
}

/**
 * How many references the panel lists. Bounded on purpose: the cap keeps one
 * very chatty room from turning the panel into a second inbox, and the count of
 * references it did not show is stated rather than swallowed.
 */
export const MAX_RECORD_REFS = 10;

const KIND_LABEL: Record<BuzzRecordKind, string> = {
  request: 'Request',
  claim: 'Claim',
  issue: 'Issue',
};

/**
 * The message fields this module reads. Structural, not `BuzzThreadMessage`:
 * Buzz's own module owns that type, and importing it here would make the room
 * view and its panel import each other.
 */
export interface BuzzMessageLike {
  id: string;
  content: string;
  createdAt: number;
  isReviewCard: boolean;
  requestId: string | null;
}

/**
 * `/console/requests/<id>` — the Console's record URLs, as people paste them.
 *
 * The id's tail stops at anything that ends a URL in running text: whitespace,
 * a query or fragment, a quote, an angle bracket, and the markdown and prose
 * punctuation that wraps one (`[text](url)`, `(see url)`, `url.`).
 */
const RECORD_URL = /\/console\/(requests|claims|issues)\/([^\s?#"'<>()[\]{}|*`\\]+)/g;

/** `?inspect=issue%3Aiss_…` — the Console's own deep link for a selected record. */
const INSPECT_PARAM = /[?&]inspect=(request|claim|issue)(?::|%3A)([^&\s"'<>]+)/gi;

const KIND_BY_SEGMENT: Record<string, BuzzRecordKind> = {
  requests: 'request',
  claims: 'claim',
  issues: 'issue',
};

/**
 * Every record a message references: the links in its body, plus — for a review
 * card — the request the card was raised for, which is a reference the message
 * carries in a tag rather than in its text.
 *
 * A malformed id is dropped rather than guessed at: the panel lists records the
 * Console can actually open, or nothing.
 */
/**
 * Every record a piece of text references. One implementation, used by the
 * thread scan and by the panel's fragment endpoint, which is asked about a
 * single href someone clicked: the server decides what a record link is, so the
 * browser never carries a second, drifting copy of that rule.
 */
export function recordRefsFromText(text: string): BuzzRecordRef[] {
  const out: BuzzRecordRef[] = [];
  const push = (kind: BuzzRecordKind, raw: string) => {
    const id = decodeId(raw);
    if (id) out.push({ kind, id });
  };
  for (const match of text.matchAll(new RegExp(RECORD_URL))) {
    const segment = match[1];
    const kind = segment ? KIND_BY_SEGMENT[segment.toLowerCase()] : undefined;
    if (kind && match[2]) push(kind, match[2]);
  }
  for (const match of text.matchAll(new RegExp(INSPECT_PARAM))) {
    const kind = match[1]?.toLowerCase() as BuzzRecordKind | undefined;
    if (kind && match[2]) push(kind, match[2]);
  }
  return out;
}

/**
 * `request:rq_1` (or its percent-encoded `request%3Arq_1`) → a reference.
 * Anything else is not a reference: an unparseable selection opens no panel
 * rather than guessing at a record.
 */
export function parseRecordRef(raw: string | null | undefined): BuzzRecordRef | null {
  if (typeof raw !== 'string') return null;
  const decoded = raw.includes('%3A') ? safeDecode(raw) : raw;
  const at = decoded.indexOf(':');
  if (at <= 0) return null;
  const kind = decoded.slice(0, at).toLowerCase();
  const id = decodeId(decoded.slice(at + 1));
  if (!isKind(kind) || !id) return null;
  return { kind, id };
}

function isKind(value: string): value is BuzzRecordKind {
  return value === 'request' || value === 'claim' || value === 'issue';
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function refsInMessage(message: BuzzMessageLike): BuzzRecordRef[] {
  const out = recordRefsFromText(message.content ?? '');
  // A review card references its request in a tag rather than in its text.
  if (message.isReviewCard && message.requestId) {
    const id = decodeId(message.requestId);
    if (id) out.push({ kind: 'request', id });
  }
  return out;
}

/** A percent-encoded id from a URL, or null when it cannot be read at all. */
function decodeId(raw: string): string | null {
  const trimmed = raw.replace(/[/.,;:]+$/, '');
  if (!trimmed) return null;
  try {
    const id = decodeURIComponent(trimmed).trim();
    // Ids are short tokens. A "link" whose tail is a whole sentence is not one.
    return id && id.length <= 200 && !/\s/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * The records a room's conversation links to, newest reference first, deduped by
 * kind and id. `withheld` counts the references past the cap, so the panel can
 * say what it left out instead of quietly truncating.
 */
export function recordRefsFromThread(messages: readonly BuzzMessageLike[]): {
  refs: BuzzRecordRef[];
  withheld: number;
} {
  const seen = new Set<string>();
  const refs: BuzzRecordRef[] = [];
  let total = 0;
  // Newest first: the most recent reference is the one the room is talking
  // about now, so it is the one the cap keeps.
  for (const message of [...messages].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))) {
    for (const ref of refsInMessage(message)) {
      const key = `${ref.kind}:${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      total += 1;
      if (refs.length < MAX_RECORD_REFS) refs.push(ref);
    }
  }
  return { refs, withheld: Math.max(0, total - refs.length) };
}

export interface BuzzContextEntry {
  kind: BuzzRecordKind;
  id: string;
  /** The record's own name where it could be read; the id otherwise. */
  title: string;
  /** The record's own state, verbatim. Empty when nothing was read. */
  state: string;
  /** Already-plain label/value pairs; escaped when rendered. */
  meta: { label: string; value: string }[];
  /** Where the full record lives — a real destination even when unreadable. */
  href: string;
  /** Non-null when the context could not be read for this viewer. */
  unavailable: string | null;
}

/**
 * Read the referenced records: one statement per kind that has references, and
 * none at all for a room that links to nothing.
 *
 * `canReadIssues` is the Issues board's own gate (department, never role — see
 * routes/issues.ts). A viewer without it is not merely refused after the read:
 * the read is not issued, and the entry states why.
 */
export async function loadBuzzContext(
  db: AsyncDb,
  tenant: string,
  refs: readonly BuzzRecordRef[],
  opts: { roomUrl: string; at: string; canReadIssues: boolean },
): Promise<BuzzContextEntry[]> {
  const idsOf = (kind: BuzzRecordKind) => refs.filter((r) => r.kind === kind).map((r) => r.id);
  const requestIds = idsOf('request');
  const claimIds = idsOf('claim');
  const issueIds = opts.canReadIssues ? idsOf('issue') : [];

  // Sequential, deliberately: one statement at a time keeps the reads ordered
  // and the cost obvious, and these are batched by id, so there is nothing to
  // overlap.
  const requests = requestIds.length
    ? await searchRequests(db, tenant, { ids: requestIds, limit: requestIds.length })
    : { rows: [] };
  const claims = claimIds.length
    ? await searchClaims(db, tenant, { ids: claimIds, limit: claimIds.length })
    : { rows: [] };
  const issues = issueIds.length ? await getIssuesByIds(db, tenant, issueIds) : [];

  const found = new Map<string, BuzzContextEntry>();
  for (const r of requests.rows) {
    found.set(`request:${r.id}`, {
      kind: 'request',
      id: r.id,
      title: r.goal,
      state: r.state,
      meta: [
        { label: 'Scope', value: `${r.originScope} → ${r.targetScope}` },
        ...aged('Updated', r.updatedAt, opts.at),
      ],
      href: `/console/requests/${encodeURIComponent(r.id)}?return=${encodeURIComponent(opts.roomUrl)}`,
      unavailable: null,
    });
  }
  for (const c of claims.rows) {
    found.set(`claim:${c.id}`, {
      kind: 'claim',
      id: c.id,
      title: c.subject,
      state: c.status,
      meta: [
        { label: 'Kind', value: c.kind },
        { label: 'Scope', value: c.scope },
        ...aged('Created', c.createdAt, opts.at),
      ],
      href: `/console/claims/${encodeURIComponent(c.id)}?return=${encodeURIComponent(opts.roomUrl)}`,
      unavailable: null,
    });
  }
  for (const i of issues) {
    found.set(`issue:${i.id}`, {
      kind: 'issue',
      id: i.id,
      title: i.title,
      state: i.state,
      meta: [
        ...(i.labels?.length ? [{ label: 'Labels', value: i.labels.join(', ') }] : []),
        ...aged('Updated', i.updatedAt, opts.at),
      ],
      // The board has no per-issue page: its addressable selection is the
      // inspector deep link, which is the record's context in the Console.
      href: `/console/issues?view=list&inspect=${encodeURIComponent(`issue:${i.id}`)}`,
      unavailable: null,
    });
  }

  return refs.map((ref) => {
    const hit = found.get(`${ref.kind}:${ref.id}`);
    if (hit) return hit;
    return {
      kind: ref.kind,
      id: ref.id,
      title: ref.id,
      state: '',
      meta: [],
      href: fallbackHref(ref, opts.roomUrl),
      unavailable:
        ref.kind === 'issue' && !opts.canReadIssues
          ? 'The Issues board is available to the engineering team only.'
          : 'This record is not readable from this workspace — it may have been removed, or it may belong to another organization.',
    };
  });
}

/** Where an unreadable reference still leads, so the entry is not a dead end. */
function fallbackHref(ref: BuzzRecordRef, roomUrl: string): string {
  const returnTo = encodeURIComponent(roomUrl);
  if (ref.kind === 'request') return `/console/requests/${encodeURIComponent(ref.id)}?return=${returnTo}`;
  if (ref.kind === 'claim') return `/console/claims/${encodeURIComponent(ref.id)}?return=${returnTo}`;
  return `/console/issues?view=list&inspect=${encodeURIComponent(`issue:${ref.id}`)}`;
}

/**
 * Buzz's own state → tone. Deliberately not the Console's mapping: the two
 * surfaces share the *meaning* of a state and share no token, so each keeps its
 * own ramp and the surface split stays true.
 */
function stateTone(state: string): 'good' | 'warn' | 'risk' | 'info' {
  if (state === 'COMPLETED' || state === 'DONE' || state === 'VERIFIED' || state === 'ACCEPTED') return 'good';
  if (
    state === 'DENIED' ||
    state === 'FAILED' ||
    state === 'TERMINATED_BUDGET' ||
    state === 'EXPIRED' ||
    state === 'DISPUTED' ||
    state === 'DECLINED'
  )
    return 'risk';
  if (state === 'PROPOSED' || state === 'ADMITTED' || state === 'QUEUED' || state === 'TO DO' || state === 'STALE')
    return 'warn';
  return 'info';
}

/** `Updated 3d ago`, or nothing at all when the timestamp cannot be read. */
function aged(label: string, iso: string | null | undefined, at: string): { label: string; value: string }[] {
  const value = fmtAge(iso ? ageMinutes(iso, at) : null);
  return value ? [{ label, value: `${value} ago` }] : [];
}

/** Minutes between an ISO timestamp and the render clock; null when unreadable. */
function ageMinutes(from: string, at: string): number | null {
  const start = Date.parse(from);
  const now = Date.parse(at);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - start) / 60_000));
}

function fmtAge(minutes: number | null): string {
  if (minutes === null) return '';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * `?open=kind:id` — the room URL's own selection. Opening a reference is a real
 * navigation, so a link to it works with JavaScript off; the shell's script
 * only upgrades the same click into a swap that keeps the conversation where it
 * is.
 */
export const PANEL_OPEN_PARAM = 'open';

/** `?panel=` — the fragment request: this region alone, for the swap script. */
export const PANEL_FRAGMENT_PARAM = 'panel';

/** `?panel=digest` — the room's reference list, as opposed to one record. */
export const PANEL_DIGEST = 'digest';

/** `request:rq_1` — the panel's key for a reference. */
export const refKey = (ref: BuzzRecordRef): string => `${ref.kind}:${ref.id}`;

/**
 * Where a reference opens *in the panel*: a real address on the room itself, so
 * the same link server-renders the opened panel when no script runs.
 */
export function panelOpenHref(roomUrl: string, ref: BuzzRecordRef): string {
  return `${roomUrl}?${PANEL_OPEN_PARAM}=${encodeURIComponent(refKey(ref))}`;
}

/**
 * The record link inside a message body, if that is what an anchor points at.
 * Message links already have the Console as their destination; the shell adds
 * the panel attribute to them, so a record link opens beside the conversation
 * when script runs and still goes to the Console when it does not.
 */
export function recordRefFromHref(href: string): BuzzRecordRef | null {
  // The href in a rendered message is HTML-escaped, so an `&inspect=` deep link
  // reaches us as `&amp;inspect=`: unescape before reading it as a URL.
  return recordRefsFromText(href.replace(/&amp;/g, '&'))[0] ?? null;
}

export interface BuzzContextPanelOptions {
  /** The room this panel belongs to, as it is shown: `#general`. */
  scope: string;
  /**
   * The room's address. Every open link is built on it, and it is where the
   * shell's script asks for the fragment when a link is clicked.
   */
  roomUrl: string;
  /** References past the cap, stated rather than swallowed. */
  withheld: number;
  /** The clock the ages are measured against. */
  at: string;
  /**
   * The reference the panel is opened on, already read by the caller. Null
   * renders the room's digest. The opened panel keeps one way back out (a real
   * link to the room, so it works with JavaScript off) and one way into the
   * Console, which is where a record is acted on.
   */
  open?: BuzzContextEntry | null;
  /**
   * Whether to emit the stylesheet. False for the fragments the swap script
   * fetches: the shell already emitted it for the document they land in.
   */
  includeStyle?: boolean;
}

/** The state chip a record carries, or nothing when no state was read. */
function stateChip(state: string, muted = false): string {
  if (!state && !muted) return '';
  const tone = muted ? 'muted' : stateTone(state);
  return `<span class="buzz-ctx-state buzz-ctx-state--${tone}">${esc(muted ? 'unavailable' : state)}</span>`;
}

function fieldList(entry: BuzzContextEntry): string {
  if (!entry.meta.length) return '';
  const fields = entry.meta
    .map((m) => `<div class="buzz-ctx-field"><dt>${esc(m.label)}</dt><dd>${esc(m.value)}</dd></div>`)
    .join('');
  return `<dl class="buzz-ctx-fields">${fields}</dl>`;
}

/**
 * The panel. Server-rendered, so it is the same panel with JavaScript off: both
 * of its controls are real URLs — opening a reference is a room URL, and the
 * Console is where the record is acted on.
 */
export function renderBuzzContextPanel(entries: readonly BuzzContextEntry[], opts: BuzzContextPanelOptions): string {
  const open = opts.open ?? null;
  const region = (head: string, body: string) => `${opts.includeStyle === false ? '' : BUZZ_CONTEXT_STYLE}
<aside class="buzz-context" data-buzz-context data-buzz-room="${esc(opts.roomUrl)}" data-open="${open ? '1' : '0'}" aria-live="polite" aria-labelledby="buzz-context-title">
${head}
${body}
</aside>`;

  const cards = entries
    .map((entry) => {
      const trigger = `<a class="buzz-ctx-name" href="${esc(panelOpenHref(opts.roomUrl, entry))}" data-buzz-panel-open="${esc(refKey(entry))}" title="Show this ${KIND_LABEL[entry.kind].toLowerCase()} beside the conversation">${esc(entry.unavailable ? entry.id : entry.title)}</a>`;
      const foot = `<p class="buzz-ctx-foot"><span class="buzz-mono">${esc(entry.id)}</span><a class="buzz-ctx-console" href="${esc(entry.href)}" title="Open this record in the Console">Console ↗</a></p>`;
      if (entry.unavailable) {
        return `<li class="buzz-ctx-card buzz-ctx-card--unavailable">
  <div class="buzz-ctx-card__top"><span class="buzz-ctx-kind">${esc(KIND_LABEL[entry.kind])}</span>${stateChip('', true)}</div>
  ${trigger}
  <p class="buzz-ctx-note">${esc(entry.unavailable)}</p>
  ${foot}
</li>`;
      }
      return `<li class="buzz-ctx-card">
  <div class="buzz-ctx-card__top"><span class="buzz-ctx-kind">${esc(KIND_LABEL[entry.kind])}</span>${stateChip(entry.state)}</div>
  ${trigger}
  ${fieldList(entry)}
  ${foot}
</li>`;
    })
    .join('\n');

  if (open) {
    const head = `<div class="buzz-ctx-head">
  <div class="buzz-ctx-crumbs">
    <a class="buzz-ctx-back" href="${esc(opts.roomUrl)}" data-buzz-panel-close title="Back to every record this room references">← All references</a>
    <a class="buzz-ctx-console" href="${esc(open.href)}" title="Open this record in the Console">Console ↗</a>
  </div>
  <h2 class="buzz-ctx-title" id="buzz-context-title">${esc(open.unavailable ? open.id : open.title)}</h2>
  <p class="buzz-ctx-sub">${esc(KIND_LABEL[open.kind])} · <span class="buzz-mono">${esc(open.id)}</span> in #${esc(opts.scope)}</p>
</div>`;
    const body = `<div class="buzz-ctx-open">
  <div class="buzz-ctx-card__top"><span class="buzz-ctx-kind">${esc(KIND_LABEL[open.kind])}</span>${stateChip(open.state, open.unavailable !== null)}</div>
  ${fieldList(open)}
  ${open.unavailable ? `<p class="buzz-ctx-note">${esc(open.unavailable)}</p>` : ''}
</div>`;
    return region(head, body);
  }

  const head = `<div class="buzz-ctx-head">
  <h2 class="buzz-ctx-title" id="buzz-context-title">Work in this room</h2>
  <p class="buzz-ctx-sub">Requests, claims and issues that #${esc(opts.scope)} references</p>
</div>`;
  const withheld = opts.withheld
    ? `<p class="buzz-ctx-withheld">${opts.withheld} more ${opts.withheld === 1 ? 'reference' : 'references'} not shown. Open the room's records in the Console to see the rest.</p>`
    : '';
  const body = entries.length
    ? `<ul class="buzz-ctx-list">${cards}</ul>${withheld}`
    : `<p class="buzz-ctx-empty">Nothing is linked here yet. Paste a request, claim or issue link into the conversation and it appears in this panel.</p>`;
  return region(head, body);
}

/**
 * Token-only, like the rest of Buzz: `--buzz-*` and nothing else. Written once
 * here rather than inline per card so the panel keeps one look.
 */
export const BUZZ_CONTEXT_STYLE = `<style>
  .buzz-context{display:flex;flex-direction:column;gap:10px;overflow-y:auto;padding:14px 14px 18px;background:var(--buzz-inset);}
  .buzz-context::-webkit-scrollbar{width:6px;}
  .buzz-context::-webkit-scrollbar-thumb{background:var(--buzz-scroll);border-radius:6px;}
  .buzz-ctx-head{display:flex;flex-direction:column;gap:2px;}
  .buzz-ctx-title{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--buzz-ink-3);margin:0;}
  .buzz-ctx-sub{font-size:11.5px;color:var(--buzz-ink-3);margin:0;overflow-wrap:anywhere;}
  .buzz-ctx-list{list-style:none;display:flex;flex-direction:column;gap:8px;padding:0;margin:0;}
  .buzz-ctx-card{display:flex;flex-direction:column;gap:6px;background:var(--buzz-surface);border:1px solid var(--buzz-border);border-radius:var(--buzz-r-md);padding:10px 11px;box-shadow:var(--buzz-shadow-card);}
  .buzz-ctx-card--unavailable{border-style:dashed;background:transparent;box-shadow:none;}
  .buzz-ctx-card__top{display:flex;align-items:center;justify-content:space-between;gap:8px;}
  .buzz-ctx-kind{font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--buzz-ink-3);}
  .buzz-ctx-state{font-size:10px;font-weight:700;letter-spacing:.02em;border-radius:var(--buzz-r-pill);padding:1px 7px;white-space:nowrap;}
  .buzz-ctx-state--good{background:var(--buzz-good-soft);color:var(--buzz-good);}
  .buzz-ctx-state--warn{background:var(--buzz-warn-soft);color:var(--buzz-warn);}
  .buzz-ctx-state--risk{background:var(--buzz-warn-soft);color:var(--buzz-risk);}
  .buzz-ctx-state--info{background:var(--buzz-info-soft);color:var(--buzz-info);}
  .buzz-ctx-state--muted{background:var(--buzz-inset-2);color:var(--buzz-ink-3);}
  .buzz-ctx-name{font-size:13px;font-weight:600;color:var(--buzz-ink-1);line-height:1.35;overflow-wrap:anywhere;transition:color .12s var(--buzz-ease);}
  .buzz-ctx-name:hover{color:var(--buzz-accent);}
  .buzz-ctx-fields{display:flex;flex-direction:column;gap:3px;margin:0;}
  .buzz-ctx-field{display:flex;justify-content:space-between;gap:10px;align-items:baseline;}
  .buzz-ctx-field dt{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--buzz-ink-3);white-space:nowrap;}
  .buzz-ctx-field dd{font-size:11.5px;color:var(--buzz-ink-2);margin:0;text-align:right;overflow-wrap:anywhere;}
  .buzz-ctx-foot{margin:0;}
  .buzz-ctx-foot .buzz-mono{font-size:10.5px;color:var(--buzz-ink-3);overflow-wrap:anywhere;}
  .buzz-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
  .buzz-ctx-note{font-size:11.5px;color:var(--buzz-ink-3);line-height:1.45;margin:0;}
  .buzz-ctx-empty{font-size:12px;color:var(--buzz-ink-3);line-height:1.5;margin:0;}
  .buzz-ctx-withheld{font-size:11px;color:var(--buzz-ink-3);line-height:1.5;margin:0;}
  /* A record opened in the panel: its own head keeps both exits, and the body
     carries the fields the digest card could not fit in one column. */
  .buzz-ctx-crumbs{display:flex;align-items:baseline;justify-content:space-between;gap:8px;}
  .buzz-ctx-back,.buzz-ctx-console{font-size:11px;font-weight:600;color:var(--buzz-ink-3);white-space:nowrap;transition:color .12s var(--buzz-ease);}
  .buzz-ctx-back:hover,.buzz-ctx-console:hover{color:var(--buzz-accent);}
  .buzz-ctx-open{display:flex;flex-direction:column;gap:8px;}
  .buzz-ctx-foot{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0;}
  /* While a swap is in flight the region says so rather than looking dead. */
  .buzz-context[aria-busy="true"]{opacity:.6;}
</style>`;
