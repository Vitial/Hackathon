import { T, eq, NOW } from './helpers.ts';
import {
  TONE_CLASS,
  accountTone,
  claimTone,
  configSourceTone,
  emptyState,
  errorState,
  invitationTone,
  issueTone,
  pageHeader,
  readinessTone,
  requestTone,
  reviewTone,
  riskBadge,
  roomTone,
  sectionHeader,
  skillCardTone,
  statusChip,
  timeline,
  timelineItem,
  toneOf,
} from '../src/console/components.ts';
import { renderAgentTaskList } from '../src/console/agent-tasks.ts';
import { renderReviewIndexPage } from '../src/console/routes/review.ts';
import { ISSUE_STATES, renderIssuesBoard, type IssueRow, type IssueState } from '../src/console/issues.ts';
import { destructiveConfirm, errorBlock, errorSummary, forbiddenBlock, timeoutBlock } from '../src/console/states.ts';

/**
 * The shared page primitives. What these tests pin:
 *  - a state maps onto one tone, and a tone onto one class, so the Inbox, a
 *    list cell and a panel cannot disagree about what DENIED looks like;
 *  - a chip always carries its label, never colour alone;
 *  - a page head, an empty block and a timeline row are each rendered in
 *    exactly one place;
 *  - every value that reaches markup is escaped.
 */

console.log('\n\x1b[1mConsole primitives — one page head, chip, empty state and timeline\x1b[0m');

T('every state maps onto one tone, and every tone onto one class', () => {
  // The five classes theme.ts defines. A tone with no class would render an
  // unstyled chip, which is how a "shared" mapping quietly stops being shared.
  eq(Object.keys(TONE_CLASS).sort(), ['good', 'info', 'neutral', 'risk', 'warn']);

  eq(requestTone('COMPLETED'), 'good');
  eq(requestTone('DENIED'), 'risk');
  eq(requestTone('FAILED'), 'risk');
  eq(requestTone('TERMINATED_BUDGET'), 'risk');
  eq(requestTone('EXPIRED'), 'risk');
  eq(requestTone('PROPOSED'), 'warn');
  eq(requestTone('ADMITTED'), 'warn');
  eq(requestTone('DECLINED'), 'neutral');
  eq(requestTone('IN_FLIGHT'), 'info');

  eq(claimTone('VERIFIED'), 'good');
  eq(claimTone('DISPUTED'), 'risk');
  eq(claimTone('STALE'), 'warn');
  eq(claimTone('OBSERVATION'), 'neutral');

  eq(issueTone('DONE'), 'good');
  eq(issueTone('IN PROGRESS'), 'info');
  eq(issueTone('TO DO'), 'warn');

  // Room health, including the badge emoji upstream still writes.
  eq(roomTone('healthy'), 'good');
  eq(roomTone('halted'), 'risk');
  eq(roomTone('degraded'), 'warn');
  eq(roomTone('idle'), 'neutral');
  eq(roomTone('', '🟢'), 'good', 'an old row with only a badge still reads:');
  eq(roomTone('', '🔴'), 'risk');

  // Membership, an invitation's lifecycle, a review, a setting's source and a
  // readiness check: each had its own answer inside the page that rendered it.
  eq(accountTone('active'), 'good');
  eq(accountTone('pending_activation'), 'warn');
  eq(accountTone('disabled'), 'risk');

  eq(invitationTone('pending'), 'info');
  eq(invitationTone('expired'), 'risk');
  eq(invitationTone('revoked'), 'risk');
  eq(invitationTone('accepted'), 'good');

  eq(reviewTone('COMPLETED'), 'good');
  eq(reviewTone('REJECTED_ALL'), 'risk');
  eq(reviewTone('CHANGES_REQUESTED'), 'warn');
  eq(reviewTone('AGENT_FIX'), 'warn');
  eq(reviewTone('SOMETHING_NEW'), 'info', 'an unknown status is live work, not an absence:');

  eq(configSourceTone('startup'), 'warn');
  eq(configSourceTone('runtime'), 'info');
  eq(configSourceTone('default'), 'neutral');

  eq(readinessTone('ok'), 'good');
  eq(readinessTone('unconfigured-optional'), 'neutral', 'never configured is grey, not red:');
  eq(readinessTone('missing'), 'risk');

  eq(skillCardTone('PROMOTED'), 'good');
  eq(skillCardTone('SHADOW'), 'info');
  eq(skillCardTone('QUARANTINE'), 'risk');
  eq(skillCardTone('DEMOTED'), 'risk');
  eq(skillCardTone('TRACE'), 'neutral');

  // A derived tone arrives as a bare string; an empty suffix means neutral, and
  // anything unrecognised must not become a class that does not exist.
  eq(toneOf(''), 'neutral');
  eq(toneOf(null), 'neutral');
  eq(toneOf('v-badge-good'), 'neutral');
  eq(toneOf('risk'), 'risk');
});

T('the status chip carries a tone, a dot, and always its own words', () => {
  const good = statusChip('COMPLETED', { tone: 'good' });
  eq(good.includes('class="v-badge v-badge-good"'), true, 'the tone becomes the class:');
  eq(good.includes('COMPLETED'), true, 'the label is rendered:');
  eq(good.includes('<span class="dot"'), true, 'with a dot by default:');
  eq(good.includes('aria-hidden="true"'), true, 'which is decoration, not content:');

  eq(
    statusChip('DENIED', { tone: 'risk', dot: false }).includes('<span class="dot"'),
    false,
    'a cell can drop the dot:',
  );

  // The size is the chip's too, so a dense table cell asks for it instead of
  // painting a smaller badge by hand.
  eq(statusChip('High').includes('v-badge-sm'), false, 'the default is the full size:');
  eq(statusChip('High', { size: 'sm' }).includes('class="v-badge v-badge v-badge-sm"'), true, 'sm is a class:');
  eq(statusChip('High', { size: 'sm' }).includes('High'), true, 'and still its own label:');

  // Extra attributes land on the chip's own element, class untouched.
  const current = statusChip('Account', { tone: 'good', attrs: 'aria-current="page"' });
  eq(current.includes('aria-current="page"'), true, 'a caller can say something about the chip:');
  eq(current.includes('class="v-badge v-badge-good"'), true, 'without touching its class:');
  eq(statusChip('RUNNING', { tone: 'info', pulse: true }).includes('v-pulse-dot'), true, 'a live chip pulses:');
  eq(statusChip('').includes('unknown'), true, 'an empty label says unknown rather than rendering nothing:');
  eq(
    statusChip('PROPOSED', { tone: 'warn', title: 'Waiting on a person' }).includes('title="Waiting on a person"'),
    true,
    'the tooltip says what the state means:',
  );
  // The label and the tooltip are data, not markup.
  const evil = statusChip('<img src=x onerror=alert(1)>', { tone: 'risk', title: '"quoted"' });
  eq(evil.includes('<img'), false, 'a label cannot inject markup:');
  eq(evil.includes('&lt;img'), true, 'it is escaped instead:');
  eq(evil.includes('title="&quot;quoted&quot;"'), true, 'and so is the tooltip:');
});

T('the page header is one block: eyebrow, title, sub, actions and the count line', () => {
  const full = pageHeader({
    eyebrow: 'Feed',
    title: 'Inbox',
    sub: 'What needs attention.',
    actions: '<nav class="v-segmented">tabs</nav>',
    count: '3 item(s) need attention',
  });
  eq(full.includes('<p class="v-eyebrow">Feed</p>'), true, 'the eyebrow:');
  eq(full.includes('<h1 class="v-page-title">Inbox</h1>'), true, 'the title:');
  eq(full.includes('What needs attention.'), true, 'the one-sentence purpose:');
  eq(full.includes('<nav class="v-segmented">tabs</nav>'), true, 'the caller\u2019s own actions, placed not invented:');
  eq(full.includes('<p class="v-meta v-count">3 item(s) need attention</p>'), true, 'and the count line under it:');

  const bare = pageHeader({ title: 'Claims' });
  eq(bare.includes('v-eyebrow'), false, 'no eyebrow, no empty element:');
  eq(bare.includes('v-sub'), false, 'no sub, none rendered:');
  eq(bare.includes('v-meta'), false, 'no count, no line:');
  eq(bare.includes('<h1 class="v-page-title">Claims</h1>'), true, 'the title is always there:');

  const escaped = pageHeader({ title: '<b>x</b>', sub: '<i>y</i>', count: '<u>z</u>' });
  eq(escaped.includes('<b>'), false, 'a title cannot inject markup:');
  eq(escaped.includes('&lt;b&gt;x&lt;/b&gt;'), true, 'it is escaped:');
  eq(escaped.includes('&lt;u&gt;z&lt;/u&gt;'), true, 'and so is the count:');
});

T('the empty state names the absence and offers the way out', () => {
  const empty = emptyState({
    title: 'No ongoing tasks',
    body: 'Nothing is in the pipeline.',
    note: 'A task appears here once a request is admitted.',
    actions: ['<a class="v-btn v-btn-secondary v-btn-sm" href="/console/requests">Browse requests</a>'],
  });
  eq(empty.includes('class="v-empty"'), true, 'the shared block:');
  eq(empty.includes('<h3>No ongoing tasks</h3>'), true, 'a title, which is the absence named:');
  eq(empty.includes('<p>Nothing is in the pipeline.</p>'), true, 'what it means:');
  eq(empty.includes('A task appears here once a request is admitted.'), true, 'and what happens next:');
  eq(empty.includes('href="/console/requests"'), true, 'with a real way out:');

  const minimal = emptyState({ title: 'Queue clear' });
  eq(minimal.includes('<h3>Queue clear</h3>'), true, 'a title alone is a valid empty state:');
  eq(minimal.includes('<p>'), false, 'and nothing is invented to fill it:');
  eq(emptyState({ title: '<x>' }).includes('&lt;x&gt;'), true, 'the title is escaped:');
  eq(emptyState({ title: 'a', body: '<b>b</b>' }).includes('&lt;b&gt;b&lt;/b&gt;'), true, 'so is the body:');
});

T('the timeline renders rows in one place — the poller is handed them, never repeats them', () => {
  const item = { title: 'request.admitted', detail: 'by eng@acme.test', time: '3m ago', tone: 'info' as const };
  eq(
    timeline([item]),
    `<div class="v-feed">${timelineItem(item)}</div>`,
    "a list of one is exactly the row renderer's output:",
  );
  const row = timelineItem(item);
  eq(row.includes('class="v-feed-icon v-feed-info"'), true, 'the tone tints the glyph:');
  eq(row.includes('<div class="v-feed-title">request.admitted</div>'), true, 'the action:');
  eq(row.includes('by eng@acme.test'), true, 'its detail:');
  eq(row.includes('3m ago'), true, 'and its age:');
  eq(row.includes('data-seq'), true, 'rows stay ordered in the markup:');

  // The glyph is the action's first letter unless the caller chooses one.
  eq(
    timelineItem({ title: 'deployed' }).includes('<div class="v-feed-icon">d</div>'),
    true,
    'first letter by default:',
  );
  eq(timelineItem({ title: 'deployed', glyph: '✔' }).includes('>✔<'), true, 'or the caller\u2019s glyph:');
  eq(timelineItem({ title: '' }).includes('·'), true, 'an empty title still gets a glyph:');
  eq(timelineItem({ title: '<b>', detail: '<i>' }).includes('&lt;b&gt;'), true, 'rows are escaped:');
  eq(timelineItem({ title: 'x', time: '' }).includes('v-feed-time'), false, 'no age, no empty cell:');

  eq(timeline([]), '', 'no rows and no copy means nothing at all:');
  eq(
    timeline([], { empty: '<p class="v-meta">No activity yet.</p>' }),
    '<p class="v-meta">No activity yet.</p>',
    'or the caller\u2019s own sentence:',
  );
});

T('the risk badge is an assessment: icon, level, and the reason it was flagged', () => {
  const low = riskBadge('low');
  eq(low.includes('v-badge-good'), true, 'a clean card is stated, not omitted:');
  eq(low.includes('✔'), true, 'with the level’s glyph:');
  eq(low.includes('Low'), true, 'and the level’s own word:');

  eq(riskBadge('watch').includes('v-badge-warn'), true, 'needs-review is the warn tint:');
  eq(riskBadge('watch').includes('Needs review'), true, 'named in full:');
  eq(riskBadge('blocked').includes('v-badge-risk'), true, 'blocked is the risk tint:');
  eq(riskBadge('blocked').includes('⛔'), true, 'and its own glyph:');

  // The actual domain label is allowed — and the level still picks the tint.
  const domain = riskBadge('watch', { label: '3 gaps' });
  eq(domain.includes('3 gaps'), true, 'the domain label wins:');
  eq(domain.includes('v-badge-warn'), true, 'the level still picks the tint:');

  // An attention badge with no reason is a mystery, so the reason travels.
  const reasoned = riskBadge('watch', { label: '2 gaps', reasons: ['no transfer test', 'drift unread'] });
  eq(reasoned.includes('title="no transfer test; drift unread"'), true, 'the reasons become the tooltip:');
  eq(riskBadge('watch', { reasons: [] }).includes('title='), false, 'and with no reasons there is no empty tooltip:');
  eq(riskBadge('blocked', { label: '"quoted"' }).includes('&quot;quoted&quot;'), true, 'the label is escaped:');
  eq(riskBadge('watch', { reasons: ['<b>'] }).includes('&lt;b&gt;'), true, 'so are the reasons:');
  // A status chip repeats a record's state; a risk badge assesses it. They must
  // not collapse into each other: the badge carries an icon, not a status dot.
  eq(riskBadge('low').includes('<span class="dot"'), false, 'no status dot on a risk badge:');
});

T('the section header places a title, its sub-line and its action slot', () => {
  const head = sectionHeader({ title: 'Live feed', sub: 'Newest last.', action: '<a href="/x">All</a>' });
  eq(head.includes('<h2 class="v-card-title">Live feed</h2>'), true, 'the heading:');
  eq(head.includes('<p class="v-sub">Newest last.</p>'), true, 'the sub-line:');
  eq(head.includes('<a href="/x">All</a>'), true, 'the caller’s own action, placed:');
  eq(head.includes('class="v-split section-head"'), true, 'in the section-head layout:');
  eq(sectionHeader({ title: 'x' }).includes('v-sub'), false, 'no sub, no empty paragraph:');
  eq(sectionHeader({ title: 'x' }).includes('section-head-action'), false, 'no action, no empty slot:');

  // `sub` is escaped; `subHtml` is markup the caller owns. Never both.
  eq(sectionHeader({ title: 'x', sub: '<b>y</b>' }).includes('&lt;b&gt;y&lt;/b&gt;'), true, 'a plain sub is escaped:');
  eq(
    sectionHeader({ title: 'x', subHtml: 'run <code>vital status</code>' }).includes('<code>vital status</code>'),
    true,
    'a caller-owned sub may name a field:',
  );

  const risk = sectionHeader({ title: 'Danger Zone', tone: 'risk' });
  eq(risk.includes('section-head--risk'), true, 'a destructive section says so in the head:');
  eq(sectionHeader({ title: '<x>' }).includes('&lt;x&gt;'), true, 'the title is escaped:');
});

T('the error state is one block, and every failure vocabulary delegates to it', () => {
  const full = errorState({
    title: 'Failed at approve.',
    body: 'The draft is preserved.',
    recovery: 'Reopen the request and retry.',
    items: ['<a href="#budget">Budget exceeded</a>'],
    actions: ['<a class="v-btn v-btn-secondary v-btn-sm" href="/console/requests">Back</a>'],
  });
  eq(full.includes('class="error-summary"'), true, 'the one failure block:');
  eq(full.includes('role="alert"'), true, 'announced, not silent:');
  eq(full.includes('<strong>Failed at approve.</strong>'), true, 'only the lead is bold — what failed:');
  eq(full.includes('The draft is preserved.'), true, 'then what survived:');
  eq(full.includes('Recovery: Reopen the request and retry.'), true, 'and the named way forward:');
  eq(full.includes('<a href="#budget">Budget exceeded</a>'), true, 'items are caller markup, so they stay links:');
  eq(full.includes('href="/console/requests"'), true, 'and so do the actions:');
  eq(full.includes('data-error-summary'), false, 'not the page summary unless asked:');
  eq(
    errorState({ title: 'x', summary: true }).includes('tabindex="-1" data-error-summary'),
    true,
    'a summary is focusable and marked:',
  );
  eq(errorState({ title: '<x>' }).includes('&lt;x&gt;'), true, 'the title is escaped:');
  eq(errorState({ title: 'x', body: '<b>' }).includes('&lt;b&gt;'), true, 'so is the body:');

  // The four alert variants `states.ts` exports are this shape: one wrapper,
  // role=alert, and no second copy of the block in that module.
  const variants = [
    errorBlock('approval', 'draft preserved', 'refresh and retry'),
    forbiddenBlock('admin'),
    timeoutBlock(),
    destructiveConfirm({ target: 'acme', consequences: 'Everything goes.', retained: 'proof rows' }),
  ];
  for (const block of variants) {
    eq(block.startsWith('<div class="error-summary" role="alert">'), true, 'the shared block:');
    eq(block.split('class="error-summary"').length - 1, 1, 'exactly one block, never a wrapper around another:');
  }
  eq(
    errorSummary([{ field: 'email', message: 'Enter an email' }]).includes('<a href="#email">Enter an email</a>'),
    true,
    'a field summary still links to its field:',
  );
});

T('the migrated surfaces render the primitives, not their own copies', () => {
  // The task list's empty page is the shared block rather than its own div.
  const list = renderAgentTaskList(
    [],
    { running: 0, waiting: 0, needsAttention: 0, tokensToday: 0, anyLive: false },
    NOW,
    '/console/agent-tasks',
  );
  eq(list.includes('class="v-empty"'), true, 'the task list uses the EmptyState block:');
  eq(list.includes('<h3>No ongoing tasks</h3>'), true, 'with the same title it always had:');
  eq(list.includes('href="/console/requests"'), true, 'and a next step rather than a dead end:');

  // The review index and the task row that links to it now print the same chip
  // for the same status, from the same map — they used to agree only by luck.
  const reviews = [
    {
      missionId: 'msn_1',
      status: 'CHANGES_REQUESTED',
      workdir: '/tmp/w',
      baselineRev: 'abc123',
      updatedAt: NOW,
      openComments: 0,
    },
  ];
  const index = renderReviewIndexPage(reviews, { csrf: 'c', now: NOW });
  eq(
    index.includes(statusChip('CHANGES_REQUESTED', { tone: reviewTone('CHANGES_REQUESTED') })),
    true,
    'the review index prints the shared chip:',
  );
  // (The task row that opens a review prints the same chip from the same map;
  // `routes.test.ts` pins that against `statusChip` over a real page, where a
  // task fixture already exists.)

  // An empty review index is the shared EmptyState, not a hand-built div.
  const none = renderReviewIndexPage([], { csrf: 'c', now: NOW });
  eq(
    none.includes(emptyState({ title: 'No code reviews opened yet' }).split('\n')[0]!),
    true,
    'the empty index is the shared block:',
  );
});

T('the Issues board reads a state with the shared chip, in its own chrome', () => {
  const row = (state: IssueState): IssueRow => ({
    id: `iss_${state.replace(/\W/g, '')}`,
    title: `An issue in ${state}`,
    description: '',
    state,
    priority: 'No priority',
    labels: [],
    assigneeEmail: null,
    createdBy: 'ada@acme.test',
    progress: state === 'DONE' ? 100 : 0,
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  // `risk: {}` — the card assessment is the board's own concern, pinned in
  // `issues-panel.test.ts`; this test is about the state chip.
  const snapshot = { issues: ISSUE_STATES.map(row), comments: [], serverTime: NOW, truncated: false, risk: {} };
  const board = renderIssuesBoard(snapshot, {
    csrf: 'c',
    home: '/console',
    engineers: [],
    currentEmail: 'ada@acme.test',
    view: 'board',
  });
  const list = renderIssuesBoard(snapshot, {
    csrf: 'c',
    home: '/console',
    engineers: [],
    currentEmail: 'ada@acme.test',
    view: 'list',
  });

  // Both views ship in one response — the switcher only toggles visibility — and a
  // card carries the same `data-id` a row does, so the row assertions have to read
  // inside the list container rather than from the top of the document.
  const listBody = list.slice(list.indexOf('id="iss-list-container"'));

  for (const state of ISSUE_STATES) {
    const chip = statusChip(state, { tone: issueTone(state) });
    eq(board.includes(`<h2 class="iss-col-title">${chip}</h2>`), true, `the ${state} column head is the chip:`);
    eq(
      list.includes(`<span class="iss-list-group-title">${chip}</span>`),
      true,
      `the ${state} list group is the same chip:`,
    );
    // The row's own cell, between its key and its title — the one place a reader
    // scans down the list for state. Sliced rather than regex-matched so a change
    // in the row's shape fails loudly instead of silently matching nothing.
    const start = listBody.indexOf(`<div class="iss-list-row" data-id="${row(state).id}"`);
    const end = listBody.indexOf('<div class="iss-row-right">', start);
    const left = listBody.slice(start, end);
    eq(start > 0 && left.includes('<span class="iss-row-key">'), true, `the ${state} row has a left cell:`);
    eq(left.includes(chip), true, `and reads its state with the same chip:`);
  }

  // The private table this replaced: a state → colour map and the ring it drew.
  // A second answer to "what colour is IN PROGRESS" is exactly what the shared
  // chip exists to prevent, so its absence is the assertion, including in CSS.
  eq(board.includes('iss-dot'), false, 'no board-owned state dot:');
  eq(board.includes('iss-row-status'), false, 'and no board-owned state ring:');
  eq(board.includes('.iss-dot'), false, 'not even a rule left in the stylesheet:');
  eq(board.includes('.iss-row-status'), false);
  eq(board.includes('.iss-col-title .v-badge'), true, 'the head cannot restyle the chip it now holds:');

  // Live sync re-renders a row in the browser. It is handed the server's own
  // chips rather than a second builder, so a synced row and a served row agree.
  const embedded = /var STATE_CHIP = (\{.*?\});/.exec(board)?.[1];
  eq(typeof embedded, 'string', 'the board script is handed the chips:');
  const chips = JSON.parse(embedded ?? '{}') as Record<string, string>;
  for (const state of ISSUE_STATES) {
    eq(chips[state], statusChip(state, { tone: issueTone(state) }), `a synced ${state} row splices it too:`);
  }
});
