/**
 * Shared console components — primitives for the operations dashboard
 * (design.md Workbench voice, brief §14 component system).
 *
 * Every primitive uses `var(--v-*)` tokens (light default, dark opt-in) and
 * renders honest fallbacks (`—`) for missing data — never invented numbers.
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface KpiCard {
  label: string;
  value: string;
  sub: string;
  href?: string;
  linkLabel?: string;
  tone?: 'default' | 'accent' | 'risk' | 'good';
  glyph?: string;
}

function kpiIconSvg(glyph?: string, label?: string): { svg: string; bg: string; color: string } {
  const lbl = (label || '').toLowerCase();
  const g = glyph || '';
  if (lbl.includes('human') || g === '!') {
    return {
      svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4.5c1.47-1.47 4.5-2 4.5-2"/><path d="M12 9v5s3.03-.55 4.5-2c1.47-1.47 2-4.5 2-4.5"/></svg>',
      bg: 'var(--v-tint-info-bg)',
      color: 'var(--v-tint-info-ink)',
    };
  }
  if (lbl.includes('spend') || g === '$') {
    return {
      svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
      bg: 'var(--v-tint-good-bg)',
      color: 'var(--v-tint-good-ink)',
    };
  }
  if (lbl.includes('room') || g === '#') {
    return {
      svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      bg: 'var(--v-tint-info-bg)',
      color: 'var(--v-tint-info-ink)',
    };
  }
  if (lbl.includes('drift') || lbl.includes('card') || g === '~') {
    return {
      svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
      bg: 'var(--v-tint-warn-bg)',
      color: 'var(--v-tint-warn-ink)',
    };
  }
  return {
    svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    bg: 'var(--v-bg-2, rgba(0,0,0,0.04))',
    color: 'var(--v-ink, currentColor)',
  };
}

/** KPI card (Picture 1 style): soft circular icon, label, large metric, action link. */
export function kpiCard(c: KpiCard): string {
  const icon = kpiIconSvg(c.glyph, c.label);
  const linkHtml = c.href
    ? `<a href="${esc(c.href)}" class="v-kpi-link" style="color:var(--v-muted);text-decoration:none;font-size:12px;font-weight:500;display:inline-flex;align-items:center;gap:4px;transition:color .15s ease;"><span>${esc(c.sub)}</span><span style="font-size:13px;line-height:1;margin-left:2px;">→</span></a>`
    : `<span style="color:var(--v-muted);font-size:12px;">${esc(c.sub)}</span>`;

  return `<div class="v-card v-kpi-card v-card-hover" style="display:flex;flex-direction:row;align-items:flex-start;gap:14px;padding:18px 20px;border-radius:18px;position:relative;overflow:hidden;background:var(--v-bg-1);border:1px solid var(--v-line);box-shadow:var(--v-card-shadow);transition:all .2s cubic-bezier(0.16,1,0.3,1);">
    <div style="width:40px;height:40px;border-radius:50%;background:${icon.bg};color:${icon.color};display:grid;place-items:center;flex-shrink:0;margin-top:2px;">
      ${icon.svg}
    </div>
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;">
      <div class="v-sub" style="font-size:12.5px;font-weight:500;color:var(--v-muted);">${esc(c.label)}</div>
      <div style="font-size:28px;font-weight:700;letter-spacing:-0.025em;color:var(--v-ink);font-variant-numeric:tabular-nums;line-height:1.15;margin:2px 0 4px;">${esc(c.value)}</div>
      <div style="font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:6px;">
        ${linkHtml}
      </div>
    </div>
  </div>`;
}

/* Hallmark · component: console-kit · genre: modern-minimal · theme: vital-light
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass
 */

/** Section wrapper with title, subtitle, and optional action link. */
export function sectionCard(title: string, sub: string, action: string, body: string): string {
  return `<section class="v-card v-section-card" style="padding:22px 24px;border-radius:18px;background:var(--v-bg-1);border:1px solid var(--v-line);box-shadow:var(--v-card-shadow);">
    <div style="margin-bottom:16px;">${sectionHeader({ title, sub, action })}</div>
    ${body}
  </section>`;
}

/* Hallmark · component: console-kit · genre: modern-minimal · theme: vital-light
 * states: default · live · neutral · good · warn · risk · info
 * contrast: pass
 */

/**
 * The five tones a console state maps onto. `theme.ts` defines exactly one
 * `.v-badge-*` class for each, so a tone can never mean two colours.
 */
export type Tone = 'good' | 'warn' | 'risk' | 'info' | 'neutral';

/** Tone → badge class. Not a second palette: each class is a `--v-tint-*` pair. */
export const TONE_CLASS: Record<Tone, string> = {
  good: 'v-badge-good',
  warn: 'v-badge-warn',
  risk: 'v-badge-risk',
  info: 'v-badge-info',
  neutral: 'v-badge',
};

/**
 * Request state → tone, over the coordinator's own states. One mapping, so the
 * Inbox, the inspector and the list pages read a request alike.
 */
export function requestTone(state: string): Tone {
  if (state === 'COMPLETED') return 'good';
  if (state === 'DENIED' || state === 'FAILED' || state === 'TERMINATED_BUDGET' || state === 'EXPIRED') return 'risk';
  if (state === 'DECLINED') return 'neutral';
  if (state === 'ACCEPTED' || state === 'IN_FLIGHT' || state === 'QUEUED' || state === 'REDIRECTED') return 'info';
  return 'warn';
}

/** Claim status → tone. DISPUTED/STALE are the two the Ledger surfaces as attention. */
export function claimTone(status: string): Tone {
  if (status === 'VERIFIED') return 'good';
  if (status === 'DISPUTED') return 'risk';
  if (status === 'STALE' || status === 'CANDIDATE') return 'warn';
  return 'neutral';
}

/** Issue state → tone, over the board's own four columns. */
export function issueTone(state: string): Tone {
  if (state === 'DONE') return 'good';
  if (state === 'IN PROGRESS') return 'info';
  if (state === 'TO DO') return 'warn';
  return 'neutral';
}

/**
 * Room health → tone. The badge emoji is upstream's own signal and is still
 * the only one a very old room row carries, so it is read as a fallback rather
 * than ignored.
 */
export function roomTone(status: string, badge = ''): Tone {
  if (status === 'healthy' || badge.includes('🟢')) return 'good';
  if (status === 'halted' || badge.includes('🔴')) return 'risk';
  if (status === 'degraded' || badge.includes('🟡')) return 'warn';
  return 'neutral';
}

/**
 * A member's membership state → tone (`membershipStatus` in core/auth.ts). The
 * team table and the account page read the same ladder, so neither decides for
 * itself what "pending activation" looks like.
 */
export function accountTone(status: string): Tone {
  if (status === 'disabled') return 'risk';
  if (status === 'pending_activation') return 'warn';
  return 'good';
}

/** An invitation's own lifecycle → tone. */
export function invitationTone(status: string): Tone {
  if (status === 'expired' || status === 'revoked') return 'risk';
  if (status === 'pending') return 'info';
  return 'good';
}

/**
 * A code review's status → tone. An unknown status is `info` rather than
 * neutral: a review the console has not been taught is live work, not the
 * absence of work.
 */
export function reviewTone(status: string): Tone {
  if (status === 'COMPLETED') return 'good';
  if (status === 'REJECTED_ALL') return 'risk';
  if (status === 'CHANGES_ACCEPTED' || status === 'CHANGES_REQUESTED' || status === 'AGENT_FIX') return 'warn';
  return 'info';
}

/** Where an effective setting's value came from (`startup` beats `runtime`). */
export function configSourceTone(source: string): Tone {
  if (source === 'startup') return 'warn';
  if (source === 'runtime') return 'info';
  return 'neutral';
}

/**
 * A readiness check's tri-state. An optional dependency that was never
 * configured is *neutral*, not risk: a red badge would claim a failure that
 * never happened.
 */
export function readinessTone(status: string): Tone {
  if (status === 'ok') return 'good';
  if (status === 'unconfigured-optional') return 'neutral';
  return 'risk';
}

/**
 * A skill card's state on the compiler's ladder (TRACE → … → PROMOTED). One
 * map, so the same `QUARANTINE` reads the same in a gap list as on the board.
 */
export function skillCardTone(state: string): Tone {
  if (state === 'PROMOTED') return 'good';
  if (state === 'QUARANTINE' || state === 'QUARANTINED' || state === 'DEMOTED' || state === 'RETIRED') return 'risk';
  if (state === 'BOUNDED_PILOT' || state === 'PILOT' || state === 'SHADOW' || state === 'SHADOW_EVAL') return 'info';
  return 'neutral';
}

/**
 * A tone read from data, where an empty suffix means neutral (`agent-tasks.ts`
 * derives `tone: ''`). Anything unrecognised is neutral rather than a class
 * that does not exist.
 */
export function toneOf(value: string | null | undefined): Tone {
  return value && value in TONE_CLASS ? (value as Tone) : 'neutral';
}

export interface StatusChipOptions {
  tone?: Tone;
  /**
   * The leading dot. On by default; never the only signal — the label is always
   * rendered next to it, so the chip reads with colour vision off.
   */
  dot?: boolean;
  /** A dot that says "moving right now", for a status that is actually live. */
  pulse?: boolean;
  /** Tooltip: say what the state means, never repeat the label. */
  title?: string;
  /**
   * Extra attributes for the chip's own element — `aria-current` on a nav item
   * is the case this exists for. The chip still owns its class, so a caller
   * cannot restyle it; it can only say something about it.
   */
  attrs?: string;
  /**
   * `sm` is for a dense table cell or a settings row: the same chip, tighter.
   * It exists because the alternative was five surfaces hand-building a neutral
   * chip so they could set its type — the chip owns its size like it owns its
   * colour, and nothing else gets to repaint it.
   */
  size?: 'md' | 'sm';
}

/**
 * StatusChip: the one state chip. A tone, a dot, and the state's own word — so
 * "DENIED" is the same red in the Inbox, a list cell and a task badge.
 */
export function statusChip(label: string, opts: StatusChipOptions = {}): string {
  const tone = opts.tone ?? 'neutral';
  let dot = '<span class="dot" aria-hidden="true"></span>';
  if (opts.pulse) dot = '<span class="v-pulse-dot" aria-hidden="true"></span>';
  else if (opts.dot === false) dot = '';
  const title = opts.title ? ` title="${esc(opts.title)}"` : '';
  const attrs = opts.attrs ? ` ${opts.attrs}` : '';
  const size = opts.size === 'sm' ? ' v-badge-sm' : '';
  return `<span class="v-badge ${TONE_CLASS[tone]}${size}"${attrs}${title}>${dot}${esc(label || 'unknown')}</span>`;
}

/* Hallmark · component: console-kit · genre: modern-minimal · theme: vital-light
 * states: none · low · needs-review · blocked · with-reason
 * contrast: pass
 */

/**
 * How bad a condition is (redesign.md §6.8 H). `low` is a real answer: a clean
 * card states that it is clean rather than omitting the badge.
 */
export type RiskLevel = 'low' | 'watch' | 'blocked';

/** The level's own word, used when the caller has no domain label of its own. */
export const RISK_LABEL: Record<RiskLevel, string> = {
  low: 'Low',
  watch: 'Needs review',
  blocked: 'Blocked',
};

/**
 * The level's glyph. An icon rather than a dot, because a risk badge is an
 * assessment and not a status light — and the glyph is what carries it when the
 * colour does not (colour is supporting information, per the spec).
 */
export const RISK_ICON: Record<RiskLevel, string> = { low: '✔', watch: '▲', blocked: '⛔' };

export interface RiskBadgeOptions {
  /**
   * The actual domain label, when one exists: `3 gaps`, `stalled`, `trusted`.
   * Defaults to the level's own word.
   */
  label?: string;
  /**
   * Why it was flagged. Becomes the tooltip, because an attention badge with no
   * reason is a mystery: the reader has to be able to find out what happened.
   */
  reasons?: readonly string[];
}

/**
 * RiskBadge: icon + level, with the colour as support. Distinct from the status
 * chip on purpose — a chip repeats a record's own state, a risk badge *assesses*
 * it, and the two answer different questions.
 */
export function riskBadge(level: RiskLevel, opts: RiskBadgeOptions = {}): string {
  const tones: Record<RiskLevel, Tone> = { low: 'good', watch: 'warn', blocked: 'risk' };
  const tone = tones[level];
  const reasons = (opts.reasons ?? []).filter(Boolean);
  const label = opts.label ?? RISK_LABEL[level];
  const title = reasons.length ? ` title="${esc(reasons.join('; '))}"` : '';
  return `<span class="v-badge ${TONE_CLASS[tone]}"${title}><span aria-hidden="true">${RISK_ICON[level]}</span>${esc(label)}</span>`;
}

export interface SectionHeaderOptions {
  title: string;
  /** One line under the title: what the section holds, or what it excludes. */
  sub?: string;
  /**
   * The same line as markup the caller owns, for a sub that names a field or an
   * authority (`<code>`, `<strong>`). Never both: `sub` is escaped, this is not.
   */
  subHtml?: string;
  /** Right of the title: a chip, a count, a link to the section's own page. */
  action?: string;
  /** Heading tone for a section that destroys or blocks. */
  tone?: 'default' | 'risk';
}

/**
 * SectionHeader: a heading inside a card, with its optional sub-line and its
 * action slot placed consistently. The page head is `pageHeader`; this is the
 * one *inside* a section, so the two are not interchangeable.
 */
export function sectionHeader(opts: SectionHeaderOptions): string {
  const sub = opts.subHtml ?? (opts.sub ? esc(opts.sub) : '');
  return `<div class="v-split section-head${opts.tone === 'risk' ? ' section-head--risk' : ''}">
  <div>
    <h2 class="v-card-title">${esc(opts.title)}</h2>
    ${sub ? `<p class="v-sub">${sub}</p>` : ''}
  </div>
  ${opts.action ? `<div class="section-head-action">${opts.action}</div>` : ''}
</div>`;
}

export interface ErrorStateOptions {
  /** Bold lead: what failed. The one part every error states. */
  title: string;
  /** What it left behind, in the reader's words. */
  body?: string;
  /** Named recovery — never "try again". */
  recovery?: string;
  /**
   * A bullet list under the lead. Already-safe markup the caller owns (a field
   * error summary links to the fields that are wrong), so it is not escaped.
   */
  items?: readonly string[];
  /** Buttons or links the caller owns. */
  actions?: readonly string[];
  /**
   * Marks the block as the page's error summary: focusable by a `#…` link, and
   * findable by `data-error-summary`. `states.ts`'s field summary sets it.
   */
  summary?: boolean;
}

/**
 * ErrorState: the one failure block — what failed, what survived, and the named
 * way forward. Every variant in `states.ts` (stage failure, 403, timeout,
 * destructive confirm, field summary) is this shape, so they all delegate here.
 */
export function errorState(opts: ErrorStateOptions): string {
  const items = (opts.items ?? []).filter(Boolean);
  const actions = (opts.actions ?? []).filter(Boolean);
  // Only the lead is bold: what failed is the headline, what survived and what
  // to do about it are the sentence that follows it.
  const rest = `${opts.body ? ` ${esc(opts.body)}` : ''}${opts.recovery ? ` Recovery: ${esc(opts.recovery)}` : ''}`;
  return `<div class="error-summary" role="alert"${opts.summary ? ' tabindex="-1" data-error-summary' : ''}>
<p><strong>${esc(opts.title)}</strong>${rest}</p>${
    items.length ? `\n<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : ''
  }${actions.length ? `\n<div class="v-split" style="margin-top:10px;">${actions.join(' ')}</div>` : ''}
</div>`;
}

export interface PageHeaderOptions {
  /** Small-caps label above the title, e.g. `Feed`. */
  eyebrow?: string;
  title: string;
  /** One sentence under the title: what this page is for. */
  sub?: string;
  /**
   * Markup placed to the right of the title — a segmented filter, a live pill, an
   * action. The caller owns it; this primitive only places it.
   */
  actions?: string;
  /** The count line under the head. Escaped here; it is always prose. */
  count?: string;
}

/**
 * PageHeader: the title block a page opens with. Extracted so every page opens
 * the same way, and so the count line lands in one place instead of three.
 */
export function pageHeader(opts: PageHeaderOptions): string {
  return `<div class="v-page-head">
  <div>
    ${opts.eyebrow ? `<p class="v-eyebrow">${esc(opts.eyebrow)}</p>` : ''}
    <h1 class="v-page-title">${esc(opts.title)}</h1>
    ${opts.sub ? `<p class="v-sub" style="margin-top:6px;">${esc(opts.sub)}</p>` : ''}
  </div>
  ${opts.actions ? `<div>${opts.actions}</div>` : ''}
</div>${
    opts.count
      ? `
<p class="v-meta v-count">${esc(opts.count)}</p>`
      : ''
  }`;
}

export interface EmptyStateOptions {
  title: string;
  /** What the emptiness *means*. Never an apology, never a shrug. */
  body?: string;
  /** A smaller second line: what the reader can do about it. */
  note?: string;
  /** Buttons/links the caller owns, laid out under the copy. */
  actions?: readonly string[];
}

/**
 * EmptyState: the one empty block. A title, what the emptiness means, and the
 * way out — so an empty page never reads as a failed read.
 *
 * `states.ts` keeps a one-sentence `emptyState(kind, …)` for empties inside a
 * table or a form; this is the page-level block.
 */
export function emptyState(opts: EmptyStateOptions): string {
  const actions = (opts.actions ?? []).filter(Boolean);
  return `<div class="v-empty">
  <h3>${esc(opts.title)}</h3>
  ${opts.body ? `<p>${esc(opts.body)}</p>` : ''}
  ${opts.note ? `<p class="v-meta">${esc(opts.note)}</p>` : ''}
  ${actions.length ? `<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">${actions.join(' ')}</div>` : ''}
</div>`;
}

export interface TimelineItem {
  /** The row's headline: what happened. Its first letter is the glyph. */
  title: string;
  /** A second line: what it was about. */
  detail?: string;
  /** An already-rendered age, e.g. `3m ago`. */
  time?: string;
  /** A single character in the left glyph instead of the title's first letter. */
  glyph?: string;
  tone?: Tone;
}

/**
 * One timeline row. Exported because the live poller re-renders rows on their
 * own — it is handed this markup rather than a second copy of the structure.
 */
export function timelineItem(item: TimelineItem): string {
  const glyph = esc(item.glyph ?? (item.title.slice(0, 1) || '·'));
  const tone = item.tone && item.tone !== 'neutral' ? ` v-feed-${item.tone}` : '';
  return `<div class="v-feed-item" data-seq>
      <div class="v-feed-icon${tone}">${glyph}</div>
      <div class="v-feed-body">
        <div class="v-feed-title">${esc(item.title)}</div>
        ${item.detail ? `<div class="v-feed-meta">${esc(item.detail)}</div>` : ''}
      </div>
      ${item.time ? `<div class="v-feed-time">${esc(item.time)}</div>` : ''}
    </div>`;
}

/** Timeline: a chronological list, newest last. `empty` is what no rows get. */
export function timeline(items: readonly TimelineItem[], opts: { empty?: string } = {}): string {
  if (items.length === 0) return opts.empty ?? '';
  return `<div class="v-feed">${items.map(timelineItem).join('')}</div>`;
}

export interface PaletteItem {
  label: string;
  hint: string;
  href?: string;
  run?: string;
  keys?: string;
}

/** ⌘K palette overlay + inline script. Items filter client-side by label. */
export function paletteHtml(items: PaletteItem[]): string {
  const data = JSON.stringify(items).replace(/</g, '\\u003c');
  return `<div id="vital-palette" role="dialog" aria-modal="true" aria-label="Command palette" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);backdrop-filter:blur(2px);padding:12vh 16px 16px;">
    <div class="v-card" style="max-width:560px;margin:0 auto;border-radius:14px;padding:8px;overflow:hidden;">
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--v-line);">
        <span aria-hidden="true" style="color:var(--v-muted);">⌘K</span>
        <input id="vital-palette-input" type="text" placeholder="Type a command or search rooms, claims, requests…" aria-label="Command palette" autocomplete="off"
          style="flex:1;border:0;outline:0;background:transparent;color:var(--v-ink);font-size:13.5px;">
        <kbd style="font-size:10px;color:var(--v-muted);border:1px solid var(--v-line);border-radius:4px;padding:1px 6px;">esc</kbd>
      </div>
      <div id="vital-palette-list" style="max-height:320px;overflow-y:auto;padding:6px;"></div>
      <div class="v-sub" style="padding:6px 10px;font-size:10.5px;border-top:1px solid var(--v-line);">↑↓ navigate · ↵ open · esc close</div>
    </div>
  </div>
  <script>(()=>{const ITEMS=${data};const root=document.getElementById('vital-palette');const input=document.getElementById('vital-palette-input');const list=document.getElementById('vital-palette-list');if(!root||!input||!list)return;let sel=0;let filtered=ITEMS;
  const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
  function draw(){list.innerHTML=filtered.length?filtered.map((it,i)=>'<button type=button data-i='+i+' style="display:flex;width:100%;text-align:left;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;border:0;cursor:pointer;background:'+(i===sel?'var(--v-accent-dim)':'transparent')+';color:var(--v-ink);font-size:13px;"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+esc(it.label)+'</span><span style="font-size:11px;color:var(--v-muted);">'+esc(it.hint||'')+(it.keys?' · '+esc(it.keys):'')+'</span></button>').join(''):'<p class=v-sub style="padding:12px;font-size:12px;">No matches. Try rooms, ledger, approvals…</p>';
  list.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>go(Number(b.dataset.i))));}
  function go(i){const it=filtered[i];if(!it)return;close();if(it.run==='toggle-theme'){document.querySelector('[data-vital-theme-toggle]')?.click();return;}if(it.href){location.href=it.href;}}
  function open(){root.style.display='block';input.value='';filtered=ITEMS;sel=0;draw();setTimeout(()=>input.focus(),0);}
  function close(){root.style.display='none';}
  window.openVitalPalette=open;
  input.addEventListener('input',()=>{const q=input.value.toLowerCase();filtered=ITEMS.filter(it=>(it.label+' '+(it.hint||'')).toLowerCase().includes(q));sel=0;draw();});
  input.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();sel=Math.min(filtered.length-1,sel+1);draw();}else if(e.key==='ArrowUp'){e.preventDefault();sel=Math.max(0,sel-1);draw();}else if(e.key==='Enter'){e.preventDefault();go(sel);}else if(e.key==='Escape'){close();}});
  root.addEventListener('click',e=>{if(e.target===root)close();});
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();root.style.display==='block'?close():open();}else if(e.key==='/'&&!/input|textarea/i.test(document.activeElement?.tagName||'')){e.preventDefault();open();}});
  draw();})();</script>`;
}

/** Keyboard hint footer for discoverability (Huly pattern). */
export function shortcutHints(): string {
  return `<p class="v-sub" style="font-size:10.5px;margin-top:10px;">Shortcuts: <kbd>⌘K</kbd> palette · <kbd>/</kbd> search · <kbd>?</kbd> compass · <kbd>g c</kbd> chat · <kbd>g h</kbd> home</p>`;
}
