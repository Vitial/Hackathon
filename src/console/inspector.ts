// Inspector — the contextual panel that opens beside a list.
//
// The contract (redesign.md §5.5, §6.8 I):
//
//   * it occupies the right edge of the content region and never covers the
//     rail or the top bar;
//   * the list stays visible behind it, and closing it loses neither filters nor
//     scroll — the filters live in the URL, and the close path is a `popstate`
//     rather than a navigation, so the scroll container is never rebuilt;
//   * the selection is deep-linkable (`?inspect=<kind>:<id>`), and that URL
//     renders the panel server-side, so the feature works with JavaScript off;
//   * the top of the panel answers "what is this and what can I do?" before any
//     technical field, and the footer carries the actions;
//   * the panel is a *view* of a record that lives elsewhere. It reads what the
//     list row already knew and links out. It never becomes the record, never
//     loads a record's payload "just in case", and adds no query of its own —
//     which is why opening one costs the page no statements it had not already
//     spent.
//
// Enhancement is progressive: with JavaScript, a click fetches the panel
// fragment and pushes state (no document navigation, so scroll and list state
// survive untouched). Without it, the same link is a normal `?inspect=` page.
// If the fragment fetch fails, the script navigates to the deep link instead of
// leaving a half-open panel — a silent failure here would look like a broken
// record.

import { esc, renderTable } from './render.ts';

export type InspectKind = 'request' | 'claim' | 'task' | 'issue';

export interface InspectTarget {
  kind: InspectKind;
  id: string;
}

/** The query parameter that carries a selection. */
export const INSPECT_PARAM = 'inspect';

/** The query parameter that asks for the panel alone, without the page. */
export const FRAGMENT_PARAM = 'fragment';

const MAX_ID_LENGTH = 200;

/**
 * `request:rq_1` → a target. Anything malformed, unknown, or empty is not a
 * target: the caller renders the list with no panel rather than guessing at a
 * record, and an unparseable value never reaches a query.
 */
export function parseInspect(raw: string | null | undefined): InspectTarget | null {
  if (typeof raw !== 'string') return null;
  const at = raw.indexOf(':');
  if (at <= 0) return null;
  const kind = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (!isKind(kind) || id.length === 0 || id.length > MAX_ID_LENGTH) return null;
  return { kind, id };
}

function isKind(value: string): value is InspectKind {
  return value === 'request' || value === 'claim' || value === 'task' || value === 'issue';
}

/** The canonical key for a target — the same string the link carries. */
export function inspectKey(target: InspectTarget): string {
  return `${target.kind}:${target.id}`;
}

/** A deep link to this page with the selection set, filters untouched. */
export function inspectHref(path: string, search: string, target: InspectTarget): string {
  const url = new URLSearchParams(search);
  url.set(INSPECT_PARAM, inspectKey(target));
  url.delete(FRAGMENT_PARAM);
  return `${path}?${url.toString()}`;
}

/** The same page with the selection removed — what closing navigates to. */
export function hrefWithoutInspect(path: string, search: string): string {
  const url = new URLSearchParams(search);
  url.delete(INSPECT_PARAM);
  url.delete(FRAGMENT_PARAM);
  const query = url.toString();
  return query ? `${path}?${query}` : path;
}

export type PanelTone = 'good' | 'warn' | 'risk' | 'info' | 'neutral';

export interface InspectorField {
  label: string;
  /** Already-escaped-by-the-builder text, or HTML the builder owns. */
  value: string;
  mono?: boolean;
}

export interface InspectorPanel {
  /** `kind:id` — must equal the key in the URL that opened it. */
  target: string;
  /** Human label for the record type ("Request", "Claim"). */
  kindLabel: string;
  title: string;
  recordId: string;
  /** The record's own state, verbatim. Never a rewritten label. */
  state: string;
  tone: PanelTone;
  /** One honest sentence: what this is and what can be done with it. */
  summary: string;
  fields: InspectorField[];
  /** Grouped related records, each already a real link. */
  refs?: { label: string; items: { label: string; href: string }[] }[];
  /**
   * The authoritative exits, most important first. `attrs` carries extra
   * attributes for an exit the page enhances itself (an action this renderer
   * has no opinion about); the `href` must still be a working destination, so
   * the exit stands with JavaScript off.
   */
  links: { label: string; href: string; primary?: boolean; attrs?: string }[];
}

const KIND_LABEL: Record<InspectKind, string> = {
  request: 'Request',
  claim: 'Claim',
  task: 'Task',
  issue: 'Issue',
};

const TONE_CLASS: Record<PanelTone, string> = {
  good: 'v-badge-good',
  warn: 'v-badge-warn',
  risk: 'v-badge-risk',
  info: 'v-badge-info',
  neutral: '',
};

/** Request state → tone. One mapping, so every surface reads the same state alike. */
export function requestTone(state: string): PanelTone {
  if (state === 'COMPLETED') return 'good';
  if (state === 'DENIED' || state === 'FAILED' || state === 'TERMINATED_BUDGET' || state === 'EXPIRED') return 'risk';
  if (state === 'DECLINED') return 'neutral';
  if (state === 'ACCEPTED' || state === 'IN_FLIGHT' || state === 'QUEUED' || state === 'REDIRECTED') return 'info';
  return 'warn';
}

/** Claim status → tone. DISPUTED/STALE are the two the Ledger surfaces as attention. */
export function claimTone(status: string): PanelTone {
  if (status === 'VERIFIED') return 'good';
  if (status === 'DISPUTED') return 'risk';
  if (status === 'STALE' || status === 'CANDIDATE') return 'warn';
  return 'neutral';
}

/** Issue state → tone, over the board's own four columns. */
export function issueTone(state: string): PanelTone {
  if (state === 'DONE') return 'good';
  if (state === 'IN PROGRESS') return 'info';
  if (state === 'TO DO') return 'warn';
  return 'neutral';
}

/** Minutes between an ISO timestamp and the server clock; null when unreadable. */
function ageMinutes(from: string, at: string): number | null {
  const start = Date.parse(from);
  const now = Date.parse(at);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - start) / 60_000));
}

/** Same ladder as the Feed: minutes, hours, days, then a dash for unknown. */
export function fmtAge(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}

/**
 * A request as the panel receives it. Deliberately a structural subset: a list
 * that reads a request *summary* renders a panel without paying for a second
 * query, and a field the row never read is omitted rather than guessed.
 *
 * `undefined`/`null` and `[]` are different claims: absent means "this page did
 * not read it", empty means "read, and there are none". Only the second may
 * render as a zero.
 */
export interface RequestPanelInput {
  id: string;
  goal: string;
  state: string;
  originScope: string;
  targetScope: string;
  deliverableSchema?: string | null;
  bid?: { dollars: number; tokens: number; humanMinutes: number; deadline: string } | null;
  claimRefs?: string[] | null;
  workflowId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A request's panel. Every field is a value the page already read; the cited
 * claims are offered as links rather than loaded, so opening a panel costs no
 * statements. A page whose rows are a summary gets a shorter panel — the exits
 * are still there, and that is what the panel is for.
 */
export function requestPanel(
  r: RequestPanelInput,
  opts: { at: string; summary?: string; recordHref: string; buzzHref?: string | null },
): InspectorPanel {
  const scope = r.targetScope || r.originScope;
  const fields: InspectorField[] = [
    { label: 'Scope', value: `${esc(r.originScope)} → ${esc(r.targetScope)}`, mono: true },
  ];
  if (r.deliverableSchema) fields.push({ label: 'Deliverable', value: esc(r.deliverableSchema), mono: true });
  if (r.bid) {
    fields.push({
      label: 'Bid',
      value: `${r.bid.dollars} USD · ${r.bid.tokens.toLocaleString()} tokens · ${r.bid.humanMinutes} human min`,
      mono: true,
    });
    fields.push({ label: 'Deadline', value: esc(r.bid.deadline), mono: true });
  }
  if (r.workflowId) fields.push({ label: 'Workflow', value: esc(r.workflowId), mono: true });
  fields.push({ label: 'Created', value: `${esc(fmtAge(ageMinutes(r.createdAt, opts.at)))} ago`, mono: true });
  fields.push({ label: 'Updated', value: `${esc(fmtAge(ageMinutes(r.updatedAt, opts.at)))} ago`, mono: true });

  const refs: InspectorPanel['refs'] = [];
  if (Array.isArray(r.claimRefs)) {
    refs.push({
      label: `Cited claims (${r.claimRefs.length})`,
      items: r.claimRefs.slice(0, 12).map((id) => ({
        label: id,
        href: `/console/claims/${encodeURIComponent(id)}`,
      })),
    });
    if (r.claimRefs.length > 12) {
      refs.push({
        label: 'More citations',
        items: [{ label: `${r.claimRefs.length - 12} more — open the record`, href: opts.recordHref }],
      });
    }
  }

  return {
    target: `request:${r.id}`,
    kindLabel: 'Request',
    title: r.goal,
    recordId: r.id,
    state: r.state,
    tone: requestTone(r.state),
    summary:
      opts.summary ??
      'Approval records a decision to BEGIN work. It is not final-deliverable authorization, and not evidence that the work ran or was measured.',
    fields,
    refs,
    links: [
      { label: 'Open full record', href: opts.recordHref, primary: true },
      ...(opts.buzzHref && scope ? [{ label: `Open in Buzz (#${scope})`, href: opts.buzzHref }] : []),
    ],
  };
}

/**
 * The Buzz room a scope belongs to. One definition, so every panel's "open in
 * Buzz" resolves the way the rail's rooms do.
 */
export function buzzHrefFor(scope: string | null | undefined): string | null {
  return scope ? `/console/buzz/${encodeURIComponent(scope)}` : null;
}

export interface ClaimPanelInput {
  id: string;
  subject: string;
  kind: string;
  status: string;
  scope: string;
  statement: string;
  createdAt: string;
}

/** A claim's panel: what is claimed, its curation state, and where it lives. */
export function claimPanel(
  c: ClaimPanelInput,
  opts: { at: string; summary?: string; recordHref: string; buzzHref?: string | null },
): InspectorPanel {
  return {
    target: `claim:${c.id}`,
    kindLabel: 'Claim',
    title: c.subject,
    recordId: c.id,
    state: c.status,
    tone: claimTone(c.status),
    summary:
      opts.summary ??
      'The Ledger is the system of record for claims. This panel is a view of that row; corrections and verification happen on the record itself.',
    fields: [
      { label: 'Kind', value: esc(c.kind), mono: true },
      { label: 'Scope', value: esc(c.scope), mono: true },
      { label: 'Created', value: `${esc(fmtAge(ageMinutes(c.createdAt, opts.at)))} ago`, mono: true },
    ],
    refs: [{ label: 'Statement', items: [{ label: c.statement, href: opts.recordHref }] }],
    links: [
      { label: 'Open full record', href: opts.recordHref, primary: true },
      ...(opts.buzzHref && c.scope ? [{ label: `Open in Buzz (#${c.scope})`, href: opts.buzzHref }] : []),
    ],
  };
}

export interface IssuePanelInput {
  id: string;
  /** The human key the row shows (e.g. `CRM-51`) — never derived here. */
  key: string;
  title: string;
  state: string;
  priority: string;
  labels: string[];
  assigneeEmail?: string | null;
  /** Absent when the row never read comments; a number is a real count. */
  comments?: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * An issue's panel. Read-only by construction: the board owns every write, and
 * this is a view of the row the list already had. The one exit hands the human
 * to the board's own editor — through the board's drawer via `data-issue-open`
 * when JavaScript is there, and through a real board URL when it is not.
 */
export function issuePanel(
  i: IssuePanelInput,
  opts: { at: string; summary?: string; editHref: string },
): InspectorPanel {
  const fields: InspectorField[] = [
    { label: 'Key', value: esc(i.key), mono: true },
    { label: 'Priority', value: esc(i.priority) },
  ];
  if (i.labels.length) fields.push({ label: 'Labels', value: esc(i.labels.join(', ')) });
  fields.push({ label: 'Assignee', value: i.assigneeEmail ? esc(i.assigneeEmail) : 'Unassigned' });
  if (typeof i.comments === 'number') fields.push({ label: 'Comments', value: String(i.comments) });
  fields.push({ label: 'Created', value: `${esc(fmtAge(ageMinutes(i.createdAt, opts.at)))} ago`, mono: true });
  fields.push({ label: 'Updated', value: `${esc(fmtAge(ageMinutes(i.updatedAt, opts.at)))} ago`, mono: true });

  return {
    target: `issue:${i.id}`,
    kindLabel: 'Issue',
    title: i.title,
    recordId: i.id,
    state: i.state,
    tone: issueTone(i.state),
    summary:
      opts.summary ??
      'The board is the system of record for issues. This panel is a view of that row: every write — move, edit, comment — happens on the board itself.',
    fields,
    links: [
      {
        label: 'Edit issue',
        href: opts.editHref,
        primary: true,
        attrs: `data-issue-open="${esc(i.id)}"`,
      },
    ],
  };
}

/** A record the current view cannot show — deleted, filtered out, or not this tenant's. */
export function unavailablePanel(target: InspectTarget, what: string): InspectorPanel {
  return {
    target: inspectKey(target),
    kindLabel: KIND_LABEL[target.kind],
    title: 'Not shown in this view',
    recordId: target.id,
    state: 'UNAVAILABLE',
    tone: 'neutral',
    summary: `${what} It is either outside the current filter, past the view's page, or no longer present. Nothing was invented to fill the panel.`,
    fields: [],
    links: [],
  };
}

/** The panel markup. No close button here: the layout owns that control. */
export function renderInspectorPanel(panel: InspectorPanel): string {
  const fields = panel.fields
    .map(
      (f) =>
        `<div class="vc-ins-field"><dt>${esc(f.label)}</dt><dd${f.mono ? ' class="v-mono"' : ''}>${f.value}</dd></div>`,
    )
    .join('');
  const refs = (panel.refs ?? [])
    .map(
      (group) =>
        `<div class="vc-ins-ref"><p class="vc-ins-label">${esc(group.label)}</p><ul>${group.items
          .map((item) => `<li><a href="${esc(item.href)}">${esc(item.label)}</a></li>`)
          .join('')}</ul></div>`,
    )
    .join('');
  const links = panel.links
    .map(
      (l) =>
        `<a class="v-btn ${l.primary ? 'v-btn-primary' : 'v-btn-secondary'} v-btn-sm"${l.attrs ? ` ${l.attrs}` : ''} href="${esc(l.href)}">${esc(l.label)}</a>`,
    )
    .join('');
  return `<div class="vc-ins-head">
  <p class="vc-eyebrow">${esc(panel.kindLabel)}</p>
  <h2 class="vc-ins-title" tabindex="-1">${esc(panel.title)}</h2>
  <p class="v-meta"><span class="v-mono">${esc(panel.recordId)}</span> · <span class="v-badge ${TONE_CLASS[panel.tone]}">${esc(panel.state)}</span></p>
</div>
<p class="vc-ins-summary">${esc(panel.summary)}</p>
${fields ? `<dl class="vc-ins-fields">${fields}</dl>` : ''}
${refs}
${links ? `<div class="vc-ins-actions">${links}<button type="button" class="v-btn v-btn-ghost v-btn-sm" data-inspect-copy hidden>Copy link</button></div>` : ''}`;
}

export interface InspectLayoutOptions {
  /** The page body: list, board, filters, headers. */
  inner: string;
  /** The panel to render open, or null for a closed inspector. */
  panel: InspectorPanel | null;
  /** Where closing goes: the same page with the selection removed. */
  closeHref: string;
  /** Accessible name for the region. */
  label?: string;
}

/**
 * The shared two-column region: content, plus the inspector at the right edge
 * of the content region. Rendered on every page that can inspect — with the
 * panel empty and the layout closed, so a client-side open has somewhere to go.
 */
export function renderInspectLayout(opts: InspectLayoutOptions): string {
  const open = opts.panel !== null;
  const panel = opts.panel ? renderInspectorPanel(opts.panel) : '';
  return `${INSPECTOR_STYLE}
<div class="vc-inspect-layout${open ? ' is-open' : ''}" data-inspect-layout data-inspect-close-href="${esc(opts.closeHref)}">
  <div class="vc-inspect-main">${opts.inner}</div>
  <button class="vc-inspect-scrim" type="button" data-inspect-close aria-label="Close record context"></button>
  <aside class="vc-inspector" id="vc-inspector" role="region" aria-label="${esc(opts.label ?? 'Record context')}" aria-busy="false">
    <div class="vc-ins-bar">
      <button type="button" class="vc-icon-btn vc-ins-close" data-inspect-close aria-label="Close record context">${ICON_CLOSE}</button>
    </div>
    ${panel}
  </aside>
</div>
${INSPECTOR_SCRIPT}`;
}

/**
 * The shared table for inspectable lists. `title` is the human-readable first
 * column (the row's own name, never the raw id); `sub` is the mono identifier
 * that rides beneath it. When a row carries a target, the title becomes the
 * inspector trigger — the id stays visible either way, so a row is readable
 * even where the panel cannot open.
 */
export interface InspectRow {
  target: InspectTarget | null;
  title: string;
  sub?: string;
  /** Remaining cells, already-built HTML, in header order after the title. */
  cells: string[];
}

export function inspectTable(
  headers: string[],
  rows: InspectRow[],
  hrefFor: (target: InspectTarget) => string,
): string {
  return renderTable(
    headers,
    rows.map((row) => {
      const sub = row.sub ? `<br><span class="v-mono v-meta">${esc(row.sub)}</span>` : '';
      const title = row.target
        ? `<a class="v-strong" href="${esc(hrefFor(row.target))}" data-inspect="${esc(inspectKey(row.target))}">${esc(row.title)}</a>`
        : `<span class="v-strong">${esc(row.title)}</span>`;
      return [`${title}${sub}`, ...row.cells];
    }),
  );
}

const ICON_CLOSE =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

/** Token-only, like every other surface stylesheet. */
export const INSPECTOR_STYLE = `<style>
.vc-inspect-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;align-items:start}
.vc-inspect-layout.is-open{grid-template-columns:minmax(0,1fr) minmax(320px,400px)}
.vc-inspect-main{min-width:0}
.vc-inspector{display:none}
.vc-inspect-layout.is-open .vc-inspector{display:block;position:sticky;top:0;align-self:start;max-height:calc(100vh - 150px);overflow-y:auto;background:var(--v-bg-1);border:1px solid var(--v-line);border-radius:var(--radius-card);box-shadow:var(--v-card-shadow);padding:14px 16px 18px}
.vc-ins-bar{display:flex;justify-content:flex-end;margin-bottom:2px}
.vc-ins-close{width:30px;height:30px}
.vc-ins-head .vc-eyebrow{margin:0}
.vc-ins-title{font-size:16px;font-weight:650;letter-spacing:-0.015em;margin:4px 0 6px;line-height:1.3;overflow-wrap:anywhere}
.vc-ins-summary{font-size:12.5px;color:var(--v-ink-2);line-height:1.5;margin:10px 0 0;padding:10px 12px;background:var(--v-tint-prose-bg);border:1px solid var(--v-line);border-radius:var(--radius-sm)}
.vc-ins-fields{margin:12px 0 0;display:grid;gap:7px}
.vc-ins-field{display:flex;justify-content:space-between;gap:12px;align-items:baseline;border-bottom:1px solid var(--v-line);padding-bottom:7px}
.vc-ins-field dt{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--v-muted);white-space:nowrap}
.vc-ins-field dd{margin:0;font-size:12.5px;color:var(--v-ink);text-align:right;overflow-wrap:anywhere}
.vc-ins-field dd.v-mono{font-size:11.5px}
.vc-ins-ref{margin-top:14px}
.vc-ins-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--v-muted);margin:0 0 6px}
.vc-ins-ref ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.vc-ins-ref li{font-size:12px;overflow-wrap:anywhere}
.vc-ins-ref a{color:var(--v-accent);text-decoration:none;font-family:var(--font-mono);font-size:11.5px}
.vc-ins-ref a:hover{text-decoration:underline}
.vc-ins-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid var(--v-line)}
.vc-inspect-scrim{display:none}
/* Below the two-column threshold the panel becomes a sheet over the content
   region: same markup, same close control, no second implementation. */
@media (max-width:1200px){
  .vc-inspect-layout.is-open{grid-template-columns:minmax(0,1fr)}
  .vc-inspect-layout.is-open .vc-inspector{position:fixed;top:0;right:0;bottom:0;width:min(420px,94vw);max-height:none;border-radius:0;border-left:1px solid var(--v-line);z-index:80;box-shadow:var(--v-card-shadow-hover);padding:14px 16px calc(18px + env(safe-area-inset-bottom))}
  .vc-inspect-layout.is-open .vc-inspect-scrim{display:block;position:fixed;inset:0;z-index:79;border:0;padding:0;background:var(--v-stage-scrim);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}
}
</style>`;

/**
 * Progressive enhancement. No framework, no dependency: intercept the trigger
 * click, fetch the fragment the same route already renders, and push state. The
 * document is never navigated, which is what makes "close without losing
 * position or filters" true rather than aspirational.
 */
export const INSPECTOR_SCRIPT = `<script>(()=>{
  const layout=document.querySelector('[data-inspect-layout]');
  if(!layout||!layout.querySelector('#vc-inspector'))return;
  const host=layout.querySelector('#vc-inspector');
  const key='inspect';
  const clean=u=>{const x=new URL(u,location.href);x.searchParams.delete('fragment');return x;};
  const hrefOf=x=>x.pathname+x.search+x.hash;
  const listHref=()=>{const u=new URL(location.href);u.searchParams.delete('inspect');return hrefOf(u);};
  let origin=null, pushed=false, busy=false;

  const restoreFocus=()=>{if(origin&&document.contains(origin))origin.focus();origin=null;};
  const clear=()=>{layout.classList.remove('is-open');host.innerHTML='';};

  const close=()=>{
    const wasPushed=pushed;
    pushed=false;
    // Going back is what preserves the list: the browser restores the previous
    // URL without rebuilding the document, so scroll and filters are untouched.
    if(wasPushed){history.back();clear();restoreFocus();return;}
    history.replaceState({},'',listHref());
    clear();restoreFocus();
  };

  const mount=html=>{
    host.innerHTML=html;
    layout.classList.add('is-open');
    const title=host.querySelector('.vc-ins-title');
    if(title)title.focus();
  };

  const open=async(href,from,push)=>{
    if(busy)return;
    busy=true;
    origin=from||null;
    const url=clean(href);
    const frag=new URL(url.toString());frag.searchParams.set('fragment','1');
    layout.setAttribute('aria-busy','true');
    if(from)from.setAttribute('aria-expanded','true');
    try{
      const res=await fetch(hrefOf(frag),{credentials:'same-origin',headers:{'x-vital-inspector':'1'}});
      if(!res.ok||!res.headers.get('content-type')?.includes('text/html'))throw new Error('fragment '+res.status);
      mount(await res.text());
      if(push){history.pushState({inspect:frag.searchParams.get('inspect')},'',hrefOf(url));pushed=true;}
    }catch{
      // Not a silent failure: the identical URL renders the panel server-side,
      // so navigating to it is the honest fallback rather than a dead click.
      location.href=hrefOf(url);
    }finally{
      busy=false;
      layout.setAttribute('aria-busy','false');
      if(from)from.setAttribute('aria-expanded','false');
    }
  };

  document.addEventListener('click',event=>{
    const node=event.target instanceof Element?event.target:null;
    if(!node)return;
    const link=node.closest('[data-inspect]');
    if(link){
      if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0)return;
      // The trigger often sits inside a row that owns its own click handler
      // (an issue list row, a task card). Selecting for the inspector is not
      // that action, so this listener is capturing and stops there: one click,
      // one outcome.
      event.preventDefault();
      event.stopPropagation();
      void open(link.getAttribute('href'),link,true);
      return;
    }
    const closer=node.closest('[data-inspect-close]');
    if(closer){event.preventDefault();close();}
  },true);

  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape')return;
    if(!layout.classList.contains('is-open'))return;
    // Escape closes the panel, never the page.
    event.preventDefault();
    event.stopPropagation();
    close();
  },true);

  window.addEventListener('popstate',()=>{
    const target=new URL(location.href).searchParams.get('inspect');
    if(target)void open(location.href,origin,false);
    else{clear();restoreFocus();pushed=false;}
  });

  // Server-rendered deep link: the panel is already in the markup. Marking the
  // layout open is enough — no fetch, no flash.
  if(new URL(location.href).searchParams.has(key)){
    layout.classList.add('is-open');
    const title=host.querySelector('.vc-ins-title');
    if(title)title.focus();
  }

  const copy=layout.querySelector('[data-inspect-copy]');
  if(copy&&navigator.clipboard&&navigator.clipboard.writeText){
    copy.hidden=false;
    copy.addEventListener('click',async()=>{
      try{await navigator.clipboard.writeText(location.href);copy.textContent='Copied';}
      catch{copy.textContent='Copy failed';}
      setTimeout(()=>{copy.textContent='Copy link';},1500);
    });
  }
})();</script>`;
