import { T, eq, TEN, NOW, fresh, sor } from './helpers.ts';
import { installAuthSchema } from '../src/core/auth.ts';
import {
  MAX_RECORD_REFS,
  loadBuzzContext,
  recordRefsFromThread,
  renderBuzzContextPanel,
  type BuzzContextEntry,
  type BuzzMessageLike,
} from '../src/console/buzz-context.ts';
import { renderBuzzRoom, renderBuzzRoomContext, createLocalReply } from '../src/console/buzz.ts';
import { renderWorkspaceShell } from '../src/console/workspace-shell.ts';
import { createIssue } from '../src/console/issues.ts';

/**
 * The Buzz record context panel. What these tests pin:
 *  - the references come from the conversation, and only from it (links in the
 *    text, and the request a review card was raised for);
 *  - a malformed id is dropped rather than guessed at;
 *  - one read per kind at most, and *no* reads when nothing is linked;
 *  - an unreadable reference keeps its link and states that its context is
 *    unavailable — it is never quietly dropped, and never filled in;
 *  - the panel is Buzz chrome: `buzz-*` and `--buzz-*` only, no Console token.
 */

console.log('\n\x1b[1mBuzz record context — the records a room links to\x1b[0m');

const message = (over: Partial<BuzzMessageLike> = {}): BuzzMessageLike => ({
  id: `msg_${Math.random().toString(36).slice(2, 8)}`,
  content: '',
  createdAt: Math.floor(Date.parse(NOW) / 1000),
  isReviewCard: false,
  requestId: null,
  ...over,
});

T('references come from the conversation: links, deep links, and review cards', () => {
  const { refs, withheld } = recordRefsFromThread([
    message({
      content: 'shipping [/console/requests/rq_1](/console/requests/rq_1) see also /console/claims/clm_2',
      createdAt: 10,
    }),
    message({ content: 'board: /console/issues?view=list&inspect=issue%3Aiss_9f2a', createdAt: 20 }),
    // A review card carries its request in a tag rather than in its text.
    message({ content: '[HUMAN ATTENTION REQUIRED]', isReviewCard: true, requestId: 'rq_3', createdAt: 30 }),
  ]);
  eq(
    refs.map((r) => `${r.kind}:${r.id}`),
    ['request:rq_3', 'issue:iss_9f2a', 'request:rq_1', 'claim:clm_2'],
    'every reference, newest message first:',
  );
  // A markdown wrapper is punctuation, not part of the id.
  eq(refs.find((r) => r.kind === 'request' && r.id.startsWith('rq_1'))?.id, 'rq_1', 'a bracket does not join the id:');
  eq(withheld, 0);
});

T('references are deduped, capped, and never guessed at', () => {
  // The same record linked twice is one entry, at the newest position.
  const dup = recordRefsFromThread([
    message({ content: '/console/requests/rq_1', createdAt: 20 }),
    message({ content: 'again: /console/requests/rq_1', createdAt: 30 }),
  ]);
  eq(dup.refs.length, 1, 'one entry for one record:');

  // Malformed ids are dropped: the panel lists records the Console can open.
  const junk = recordRefsFromThread([
    message({ content: 'a path, not a record: /console/requests/' }),
    message({ content: 'trailing slash on nothing: /console/claims//' }),
    message({ content: 'percent-encoding that cannot be read: /console/requests/%E0%A4%A' }),
    message({ content: 'not a record kind: /console/accounts/acct_1' }),
    message({ content: 'still a sentence: /console/requests/rq_ok' }),
  ]);
  eq(
    junk.refs.map((r) => r.id),
    ['rq_ok'],
    'only the well-formed reference survives:',
  );

  // Percent-encoded ids decode — the Console encodes what it links.
  const encoded = recordRefsFromThread([message({ content: '/console/claims/clm%2Fodd' })]);
  eq(encoded.refs[0]?.id, 'clm/odd', 'a percent-encoded id decodes:');

  // Past the cap the panel withholds, and says how many.
  const many = recordRefsFromThread(
    Array.from({ length: MAX_RECORD_REFS + 3 }, (_, i) =>
      message({ content: `/console/requests/rq_${i}`, createdAt: i }),
    ),
  );
  eq(many.refs.length, MAX_RECORD_REFS, 'the cap holds:');
  eq(many.withheld, 3, 'and what it did not show is counted:');
});

T('one read per kind — and none at all when nothing is linked', async () => {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  const claim = await ctx.ledger.append({
    tenant: TEN,
    subject: 'deploy_rotation',
    kind: 'OBSERVATION',
    statement: 'The deploy keys were rotated on schedule',
    confidence: 0.9,
    observedAt: NOW,
    validFrom: NOW,
    owner: 'eng@acme.test',
    scope: 'core',
    authorType: 'human',
    provenance: sor(),
  });
  const issue = await createIssue(
    ctx.db,
    TEN,
    { title: 'Rotate the deploy keys', state: 'TO DO', priority: 'High', labels: ['DevOps'] },
    { userId: 'u1', email: 'eng@acme.test' },
    NOW,
  );

  // A room with nothing linked pays nothing: not an empty query, no query.
  const idle = await loadBuzzContext(ctx.db, TEN, [], {
    roomUrl: '/console/buzz/general',
    at: NOW,
    canReadIssues: true,
  });
  eq(idle, [], 'no references, no entries:');

  const refs = [
    { kind: 'request' as const, id: 'rq_missing' },
    { kind: 'claim' as const, id: claim.id },
    { kind: 'issue' as const, id: issue.id },
  ];
  const entries = await loadBuzzContext(ctx.db, TEN, refs, {
    roomUrl: '/console/buzz/general',
    at: NOW,
    canReadIssues: true,
  });
  eq(entries.length, 3, 'one entry per reference:');

  const claimEntry = entries.find((e) => e.kind === 'claim')!;
  eq(claimEntry.title, 'deploy_rotation', 'a claim shows its own subject:');
  eq(claimEntry.state, claim.status, 'and its own status, verbatim:');
  eq(claimEntry.href.includes(`/console/claims/${encodeURIComponent(claim.id)}`), true, 'and opens in the Console:');
  eq(claimEntry.href.includes('return=%2Fconsole%2Fbuzz%2Fgeneral'), true, 'with the room as the way back:');

  const issueEntry = entries.find((e) => e.kind === 'issue')!;
  eq(issueEntry.title, 'Rotate the deploy keys', 'an issue shows its title:');
  eq(issueEntry.href.includes('inspect=issue%3A'), true, 'and links to the board inspector:');

  // A request the store does not have is stated, not invented.
  const missing = entries.find((e) => e.kind === 'request')!;
  eq(missing.unavailable !== null, true, 'an unreadable record says so:');
  eq(missing.title, 'rq_missing', 'and shows the id it was given, not a title it never read:');
  eq(missing.href.includes('/console/requests/rq_missing'), true, 'its link still leads to the record:');
});

T('issue context needs the Issues board gate; its reads are not even issued without it', async () => {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  const issue = await createIssue(
    ctx.db,
    TEN,
    { title: 'Rotate the deploy keys', state: 'TO DO', priority: 'High', labels: [] },
    { userId: 'u1', email: 'eng@acme.test' },
    NOW,
  );
  const entries = await loadBuzzContext(ctx.db, TEN, [{ kind: 'issue', id: issue.id }], {
    roomUrl: '/console/buzz/general',
    at: NOW,
    canReadIssues: false,
  });
  eq(entries[0]?.unavailable, 'The Issues board is available to the engineering team only.');
  eq(entries[0]?.title, issue.id, 'nothing about the issue is rendered:');
  eq(entries[0]?.meta, [], 'and no fields are filled in:');
});

T('the panel is Buzz chrome: links out, an honest empty state, and no Console token', () => {
  const empty = renderBuzzContextPanel([], {
    scope: 'general',
    roomUrl: '/console/buzz/general',
    withheld: 0,
    at: NOW,
  });
  eq(empty.includes('Work in this room'), true, 'the panel names itself:');
  eq(empty.includes('Nothing is linked here yet'), true, 'an empty room is told what to do, not shown a blank:');
  eq(empty.includes('--v-'), false, 'no Console token in the panel:');
  eq(empty.includes('--buzz-'), true, 'Buzz tokens only:');

  const html = renderBuzzContextPanel(
    [
      {
        kind: 'request',
        id: 'rq_1',
        title: 'Ship <the> "release"',
        state: 'ADMITTED',
        meta: [{ label: 'Scope', value: 'core → product' }],
        href: '/console/requests/rq_1?return=%2Fconsole%2Fbuzz%2Fgeneral',
        unavailable: null,
      },
      {
        kind: 'issue',
        id: 'iss_1',
        title: 'iss_1',
        state: '',
        meta: [],
        href: '/console/issues?view=list&inspect=issue%3Aiss_1',
        unavailable: 'The Issues board is available to the engineering team only.',
      },
    ],
    { scope: 'general', roomUrl: '/console/buzz/general', withheld: 2, at: NOW },
  );
  eq(html.includes('Ship &lt;the&gt; &quot;release&quot;'), true, 'a title is escaped:');
  eq(html.includes('buzz-ctx-state--warn'), true, 'a pending state gets Buzz\u2019s warn tone:');
  eq(html.includes('buzz-ctx-card--unavailable'), true, 'an unreadable reference still gets a card:');
  eq(html.includes('2 more references not shown'), true, 'what the cap withheld is stated:');
  eq(html.includes('--v-'), false, 'still no Console token:');

  // A card's own link opens the record in the panel rather than leaving the
  // room, and it is a real URL, so the same click works with no script at all.
  eq(html.includes('href="/console/buzz/general?open=request%3Arq_1"'), true, 'a card opens its record in the panel:');
  eq(html.includes('data-buzz-panel-open="request:rq_1"'), true, 'with the selection the shell reads:');
  eq(
    html.includes('href="/console/requests/rq_1?return=%2Fconsole%2Fbuzz%2Fgeneral"'),
    true,
    'and the Console stays one labelled click away:',
  );
  eq(html.includes('data-buzz-room="/console/buzz/general"'), true, 'the region names the room it belongs to:');
  eq(html.includes('data-open="0"'), true, 'and says it is showing the digest:');
});

T('a record opened in the panel keeps both exits, and reads the same with JavaScript off', () => {
  const claim: BuzzContextEntry = {
    kind: 'claim',
    id: 'clm_1',
    title: 'deploy_rotation',
    state: 'DISPUTED',
    meta: [{ label: 'Kind', value: 'OBSERVATION' }],
    href: '/console/claims/clm_1?return=%2Fconsole%2Fbuzz%2Fgeneral',
    unavailable: null,
  };
  const html = renderBuzzContextPanel([claim], {
    scope: 'general',
    roomUrl: '/console/buzz/general',
    withheld: 0,
    at: NOW,
    open: claim,
  });
  eq(html.includes('data-open="1"'), true, 'the region is showing a record:');
  eq(html.includes('← All references'), true, 'the digest is one link back:');
  eq(html.includes('href="/console/buzz/general"'), true, 'and that link is the room itself:');
  eq(html.includes('data-buzz-panel-close'), true, 'which the shell upgrades into a swap:');
  eq(html.includes('deploy_rotation'), true, 'the record shows its own subject:');
  eq(html.includes('DISPUTED'), true, 'and its own state:');
  eq(html.includes('/console/claims/clm_1?return='), true, 'its Console page is still one click:');
  eq(
    html.includes('<ul class="buzz-ctx-list">'),
    false,
    'the opened panel shows the record, not the digest behind it:',
  );
  eq(html.includes('--v-'), false, 'still no Console token:');

  // A selection nobody can read is opened too, and says why rather than
  // pretending it has fields.
  const gated: BuzzContextEntry = {
    kind: 'issue',
    id: 'iss_9',
    title: 'iss_9',
    state: '',
    meta: [],
    href: '/console/issues?view=list&inspect=issue%3Aiss_9',
    unavailable: 'The Issues board is available to the engineering team only.',
  };
  const gatedHtml = renderBuzzContextPanel([], {
    scope: 'general',
    roomUrl: '/console/buzz/general',
    withheld: 0,
    at: NOW,
    open: gated,
  });
  eq(gatedHtml.includes('data-open="1"'), true, 'an unreadable selection still opens:');
  eq(gatedHtml.includes('available to the engineering team only'), true, 'and states why it is empty:');
  eq(gatedHtml.includes('iss_9'), true, 'showing the id it was given, not a title it never read:');
});

T('the room hands the panel to the shell, and the shell gives it the room', async () => {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);

  const room = (open: { kind: 'request'; id: string } | null = null) =>
    renderBuzzRoom(ctx.db, TEN, 'general', '/', 'csrf_test', null, undefined, 'u1', undefined, 'engineering', open);
  const shell = (inner: string, contextPanel?: string) =>
    renderWorkspaceShell({
      rooms: [],
      home: '/',
      consoleNav: '',
      accountCluster: '',
      innerHtml: inner,
      metrics: null,
      roomRecency: {},
      contextPanel,
    });

  const idle = await room();
  eq(idle !== null, true, 'the room renders:');
  if (!idle) return;
  // The region is the shell's column, so the room body does not carry it.
  eq(idle.body.includes('data-buzz-context'), false, 'the room body is just the room:');
  eq(idle.contextPanel.includes('Nothing is linked here yet'), true, 'and the region says so honestly:');
  eq(idle.contextPanel.includes('buzz-context-title'), true, 'with an accessible name:');
  eq(idle.contextPanel.includes('<style>'), false, 'the region carries no stylesheet of its own:');

  const plain = shell(idle.body);
  eq(
    plain.includes('class="buzz-window buzz-window--context"'),
    false,
    'a surface with no panel makes no room for one:',
  );
  eq(plain.includes('<aside class="buzz-context"'), false, 'and renders none:');
  eq(plain.includes('.buzz-ctx-card'), false, 'nor its stylesheet:');

  const withPanel = shell(idle.body, idle.contextPanel);
  eq(withPanel.includes('class="buzz-window buzz-window--context"'), true, 'the shell makes room for the region:');
  eq(withPanel.includes('<aside class="buzz-context"'), true, 'and renders it:');
  eq(
    withPanel.indexOf('<aside class="buzz-context"') > withPanel.indexOf('buzz-content-card'),
    true,
    'on the far side of the conversation:',
  );
  eq(withPanel.includes('.buzz-ctx-card'), true, 'with the stylesheet emitted once, by the shell:');
  eq(withPanel.includes("querySelector('[data-buzz-context]')"), true, 'and the swap wired:');
  eq(withPanel.includes('?panel='), true, 'against the region fragment:');
  // The shell document stays Buzz's. Checked the way the surface-split test does
  // it — no token defined and nothing *using* one — rather than by grepping for
  // the substring, which the stylesheet's own comment legitimately contains.
  eq(/--v-[a-z0-9-]+\s*:/.test(withPanel), false, 'the shell defines no Console token:');
  eq(withPanel.includes('var(--v-'), false, 'and uses none:');

  // Now the room links to a record the tenant owns, from a message.
  await createLocalReply(
    ctx.db,
    TEN,
    'general',
    null,
    'eng@acme.test',
    'handoff: [the request](/console/requests/rq_linked)',
  );
  const linked = await room();
  if (!linked) return;
  eq(linked.contextPanel.includes('rq_linked'), true, 'the linked record is in the panel:');
  eq(linked.contextPanel.includes('/console/requests/rq_linked?return='), true, 'with the room as the way back:');

  // A link in the conversation opens the panel too — and still keeps the
  // Console as its own destination for anyone without the script.
  eq(linked.body.includes('data-buzz-panel-open="request:rq_linked"'), true, 'a message link opens the panel:');
  eq(linked.body.includes('href="/console/requests/rq_linked"'), true, 'and is unchanged as a link:');

  // `?open=` is part of the room's address, so a shared link lands on the
  // record it names even with no script at all.
  const opened = await room({ kind: 'request', id: 'rq_linked' });
  if (!opened) return;
  eq(opened.contextPanel.includes('data-open="1"'), true, '?open= server-renders the opened record:');
  eq(opened.contextPanel.includes('data-buzz-panel-close'), true, 'with its way back to the digest:');
});

T('the context region is fetchable on its own, and a click costs no page', async () => {
  const ctx = await fresh();
  await installAuthSchema(ctx.db, NOW);
  await createLocalReply(ctx.db, TEN, 'general', null, 'eng@acme.test', 'see [r](/console/requests/rq_frag)');

  const region = (open: { kind: 'request'; id: string } | null) =>
    renderBuzzRoomContext(ctx.db, TEN, 'general', null, {
      roomUrl: '/console/buzz/general',
      viewerTeam: 'engineering',
      open,
    });

  const digest = await region(null);
  eq(digest !== null, true, 'the region is fetchable on its own:');
  eq(digest!.includes('<style>'), false, 'as markup only: the shell already has its stylesheet:');
  eq(digest!.includes('data-buzz-context'), true, 'the region itself:');
  eq(digest!.includes('data-open="0"'), true, 'showing the digest:');
  eq(digest!.includes('rq_frag'), true, 'with the references this room links to:');

  const one = await region({ kind: 'request', id: 'rq_frag' });
  eq(one!.includes('data-open="1"'), true, 'or one record:');

  // A reference the room does not link to is still honoured — read on its own —
  // and one nobody can read is stated rather than filled in.
  const other = await region({ kind: 'request', id: 'rq_elsewhere' });
  eq(other!.includes('rq_elsewhere'), true, 'a deep link to an unlinked record opens:');
  eq(other!.includes('not readable from this workspace'), true, 'and says it could not be read:');

  eq(
    await renderBuzzRoomContext(ctx.db, TEN, 'no_such_room', null, {
      roomUrl: '/console/buzz/no_such_room',
      open: null,
    }),
    null,
    'an unknown room has no region:',
  );
});
