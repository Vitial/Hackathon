/**
 * Feed / Inbox — ranked attention, built from reads that already existed.
 *
 * What this pins, and why each one is worth a test rather than a screenshot:
 *
 *   1. The model is a *projection*. Every item must trace to a request or claim
 *      row that already existed, and the same record must never appear twice.
 *      A feed that invents an item, or double-counts one, is a second source of
 *      truth wearing a dashboard.
 *   2. The ranking is explicit: decisions, then blocked work, then contested
 *      evidence; oldest first inside each. If that order is not asserted, a
 *      refactor can reorder attention silently.
 *   3. The cap is honest. Items it withholds are *counted*, so the page can say
 *      how many it did not show instead of implying it showed everything.
 *   4. `awaitingHumanReview` is one function shared with the approval queue
 *      (review.ts), so the Inbox can never advertise a decision the approvals
 *      page does not render.
 *   5. The route declares its own capability (session, html, activation) and is
 *      read-only — a GET with no body policy.
 *
 * Nothing here writes: the feed reads, links to the authoritative record, and
 * stops.
 */

import { T, eq, TEN, NOW, DAY_LATER, fresh, sor, base } from './helpers.ts';
import { installAuthSchema, signupTenant } from '../src/core/auth.ts';
import { startConsoleServer } from '../src/console/serve.ts';
import type { Ledger } from '../src/ledger/ledger.ts';
import { FEED_LIMIT, FEED_TABS, buildFeed, fmtAge, renderFeedPage, resolveFeedTab } from '../src/console/feed.ts';
import {
  hrefWithoutInspect,
  inspectHref,
  inspectKey,
  inspectTable,
  parseInspect,
  renderInspectorPanel,
  requestPanel,
  unavailablePanel,
} from '../src/console/inspector.ts';
import { FEED_CAPABILITIES, feedRoutes } from '../src/console/routes/feed.ts';
import { routeManifest, validateRoutes } from '../src/console/routes/registry.ts';

console.log('\n\x1b[1mFeed — attention ranked, never invented\x1b[0m');

/**
 * Append a claim and take it through the real curation step to VERIFIED. No SQL
 * shortcuts: if the ledger stops verifying, these tests should fail.
 *
 * Every claim here carries an already-lapsed validity window, which is what lets
 * `markStale` reach STALE the way the sweep does in production.
 */
async function verifiedClaim(ledger: Ledger, id: string) {
  const claim = await ledger.append({
    id,
    tenant: TEN,
    subject: `subject:${id}`,
    kind: 'OBSERVATION',
    statement: `statement for ${id}`,
    confidence: 1,
    observedAt: NOW,
    validFrom: NOW,
    validUntil: NOW,
    owner: 'sync:gh',
    scope: 'engineering',
    authorType: 'system',
    provenance: sor(),
  });
  return ledger.verifyClaim(TEN, claim.id, 'human:ada', NOW);
}

T('the feed ranks decisions, then blocked work, then contested evidence', async () => {
  const { db, ledger, coord } = await fresh({ maxHumanEscalationsPerDay: 20, maxConcurrentPerScope: 99 });
  try {
    // Two requests waiting on a person, three hours apart. They stay ADMITTED:
    // accepting one is the human's decision, and a decision already taken is
    // not attention.
    await coord.submit(
      base({ id: 'dec-old', goal: 'first decision', bid: { humanMinutes: 5 }, now: '2026-09-09T09:00:00.000Z' }),
    );
    await coord.submit(base({ id: 'dec-new', goal: 'second decision', bid: { humanMinutes: 5 } }));

    // A failed execution, a denied admission, and two settled outcomes that
    // must NOT appear: a decision already made is not attention.
    const failed = await coord.submit(base({ id: 'blk-failed', goal: 'failed run' }));
    await coord.fail(TEN, failed.request.id, 'transient model error');
    await coord.submit(
      base({ id: 'blk-denied', goal: 'denied query', messageClass: 'QUERY' as const, bid: { dollars: 5 } }),
    );
    const done = await coord.submit(base({ id: 'settled-done', goal: 'shipped' }));
    await coord.complete(TEN, done.request.id, { claims: [], cost: {} });
    const declined = await coord.submit(base({ id: 'settled-declined', goal: 'out of scope' }));
    await coord.decline(TEN, declined.request.id, 'not this quarter');

    // Two claims in contradiction (I4: a contradiction is an event, and both
    // sides are demoted to DISPUTED), one stale claim, and one verified fact
    // that is not news and must stay out of the feed.
    await verifiedClaim(ledger, 'clm_disputed');
    await verifiedClaim(ledger, 'clm_contested');
    await ledger.link(TEN, 'clm_disputed', 'clm_contested', 'contradicts');
    await verifiedClaim(ledger, 'clm_stale');
    await ledger.markStale(TEN, DAY_LATER);
    await verifiedClaim(ledger, 'clm_verified');

    const model = await buildFeed({ db, coord, tenant: TEN, at: DAY_LATER, here: '/console/inbox' });

    eq(model.counts, { decision: 2, blocked: 2, evidence: 3 }, 'counts come from the rows:');
    eq(
      model.items.map((i) => i.kind),
      ['decision', 'decision', 'blocked', 'blocked', 'evidence', 'evidence', 'evidence'],
      'decisions first, then blocked, then evidence:',
    );
    // Oldest first inside a kind: the thing that has waited longest is the most
    // urgent thing, and a sort by recency would invert that.
    eq(model.items[0]!.recordId, 'dec-old', 'the older decision leads:');
    eq(model.items[1]!.recordId, 'dec-new', 'then the newer decision:');
    eq(model.items[0]!.ageMinutes! > model.items[1]!.ageMinutes!, true, 'and it leads because it is older:');
    eq(
      model.items.map((i) => i.rank),
      [0, 1, 2, 3, 4, 5, 6],
      'rank is the position, not a stored field:',
    );
    // Complete projection: every id offered is a record that exists, and the
    // settled rows are absent.
    const ids = new Set(model.items.map((i) => i.recordId));
    eq(ids.has('settled-done'), false, 'completed work is not attention:');
    eq(ids.has('settled-declined'), false, 'a decision already taken is not attention:');
    eq(ids.has('clm_verified'), false, 'a verified fact in good standing is not attention:');
    eq(ids.has('blk-failed'), true, 'the failed run is:');
    eq(ids.has('blk-denied'), true, 'the denied admission is:');
    // Every item links to its own record and says why it is here.
    for (const item of model.items) {
      eq(item.href.includes(encodeURIComponent(item.recordId)), true, `${item.recordId} links to its record:`);
      eq(item.why.length > 0, true, `${item.recordId} states a reason:`);
      eq(item.ageMinutes !== null, true, `${item.recordId} carries a real age:`);
    }
    // The genesis request was created at NOW and the model is read a day later.
    eq(model.omitted, 0, 'nothing withheld at this size:');
    eq(model.considered, 7, 'considered is the pre-cap total:');
    eq(model.sources, ['requests', 'claims'], 'the page names its sources:');
  } finally {
    await db.close();
  }
});

T('the feed caps, and says how much it withheld', async () => {
  const { db, ledger, coord } = await fresh({ maxHumanEscalationsPerDay: 200, maxConcurrentPerScope: 200 });
  try {
    const extra = 3;
    // Claims, not requests: the point here is the cap, and claims carry no
    // per-scope concurrency ceiling to fight.
    for (let i = 0; i < FEED_LIMIT + extra; i++) {
      await verifiedClaim(ledger, `clm_bulk_${String(i).padStart(3, '0')}`);
    }
    await ledger.markStale(TEN, DAY_LATER);
    const model = await buildFeed({ db, coord, tenant: TEN, at: DAY_LATER, here: '/console/inbox' });
    eq(model.items.length, FEED_LIMIT, `the feed shows at most ${FEED_LIMIT}:`);
    eq(model.considered, FEED_LIMIT + extra, 'considered counts everything found:');
    eq(model.omitted, extra, 'omitted is the difference, not a guess:');
    // The page must state the withholding rather than imply completeness.
    const html = renderFeedPage({ model, tab: 'all' });
    eq(html.includes(`${model.omitted} more withheld by the ${FEED_LIMIT}-item cap`), true, 'the cap is disclosed:');
  } finally {
    await db.close();
  }
});

T('a dispute that resolves leaves the feed, and a budget halt enters it', async () => {
  const { db, ledger, coord } = await fresh({ maxHumanEscalationsPerDay: 20, maxConcurrentPerScope: 99 });
  try {
    // Two verified claims that contradict each other: both are attention.
    await verifiedClaim(ledger, 'clm_lhs');
    await verifiedClaim(ledger, 'clm_rhs');
    await ledger.link(TEN, 'clm_lhs', 'clm_rhs', 'contradicts');
    const disputed = await buildFeed({ db, coord, tenant: TEN, at: DAY_LATER, here: '/console/inbox' });
    eq(disputed.counts.evidence, 2, 'both sides of a live contradiction are attention:');

    // Resolving it promotes the winner and supersedes the loser — neither is
    // DISPUTED any more, so neither belongs in a ranked queue of unresolved
    // problems. This is the half that a count-only test would miss.
    await ledger.resolveDispute(
      TEN,
      'clm_lhs',
      'clm_rhs',
      'clm_lhs',
      'left is the system of record',
      'human:ada',
      DAY_LATER,
    );
    eq((await ledger.get(TEN, 'clm_lhs'))!.status, 'VERIFIED', 'the winner is restored:');
    eq((await ledger.get(TEN, 'clm_rhs'))!.status, 'SUPERSEDED', 'the loser is superseded:');
    const resolved = await buildFeed({ db, coord, tenant: TEN, at: DAY_LATER, here: '/console/inbox' });
    eq(resolved.counts.evidence, 0, 'a resolved dispute is not attention:');
    eq(resolved.considered, 0, 'and the feed is empty, not stale:');

    // Budget death is a distinct terminal state from failure, and it is
    // attention: someone has to decide whether the work continues.
    const halted = await coord.submit(
      base({ id: 'rq_halted', goal: 'cost-cap run', bid: { dollars: 1, maxRounds: 2 } }),
    );
    await coord.charge(TEN, halted.request.id, { dollars: 0.6 });
    const after = await coord.charge(TEN, halted.request.id, { dollars: 0.6 });
    eq(after.state, 'TERMINATED_BUDGET', 'the request is halted on budget:');
    const withHalt = await buildFeed({ db, coord, tenant: TEN, at: DAY_LATER, here: '/console/inbox' });
    eq(withHalt.counts.blocked, 1, 'the halt is in the feed:');
    eq(withHalt.items[0]!.recordId, 'rq_halted', 'as the only item:');
    eq(withHalt.items[0]!.state, 'TERMINATED_BUDGET', 'with its own state, not a rewritten label:');
    eq(withHalt.items[0]!.why, 'Halted on budget.', 'and its own reason:');
  } finally {
    await db.close();
  }
});

T('the inspector primitives keep filters, and refuse a target they cannot name', () => {
  const search = '?view=blocked&q=co%2Fdeploy';
  const target = { kind: 'request' as const, id: 'rq_1' };
  const deep = inspectHref('/console/inbox', search, target);
  // Filters survive selection, and the selection is additive.
  eq(deep.includes('view=blocked'), true, 'the tab survives:');
  eq(deep.includes('q=co%2Fdeploy'), true, 'the search survives:');
  eq(deep.includes('inspect=request%3Arq_1'), true, 'and the selection is encoded:');
  eq(inspectKey(target), 'request:rq_1', 'the key is kind:id:');
  // Closing returns to exactly the list state it left.
  eq(
    hrefWithoutInspect('/console/inbox', search + '&inspect=request%3Arq_1'),
    '/console/inbox' + search,
    'closing restores the list URL:',
  );
  eq(
    hrefWithoutInspect('/console/inbox', '?inspect=claim%3Aclm_1'),
    '/console/inbox',
    'and strips the selection alone:',
  );

  // Parsing is strict: a malformed or unknown target is no target, so no query
  // is ever built from it.
  eq(parseInspect('request:rq_1'), target, 'a well-formed target parses:');
  eq(parseInspect('rq_1'), null, 'a bare id is not a target:');
  eq(parseInspect('widget:rq_1'), null, 'an unknown kind is not a target:');
  eq(parseInspect('request:'), null, 'an empty id is not a target:');
  eq(parseInspect(null), null, 'no selection is not a target:');
  eq(parseInspect('request:' + 'x'.repeat(400)), null, 'an absurd id is refused:');
});

T('the panel states what it cannot show instead of inventing it', () => {
  // The unavailable state is a real state, not an error page: deleted, filtered
  // out, and past-the-page all render it, and it names the record it could not
  // show without leaking a payload it never read.
  const panel = unavailablePanel(
    { kind: 'request', id: 'rq_gone' },
    'This request is not among the rows this page read.',
  );
  const html = renderInspectorPanel(panel);
  eq(html.includes('Not shown in this view'), true, 'the state is named:');
  eq(html.includes('rq_gone'), true, 'the record is named:');
  eq(html.includes('Nothing was invented to fill the panel.'), true, 'and the honesty is explicit:');
  eq(html.includes('v-btn-primary'), false, 'no action is offered for a record it cannot show:');

  // A request panel's numbers are the row's own bid, and its exits are links
  // rather than loads: no claim is fetched to draw it.
  const request = requestPanel(
    {
      id: 'rq_2',
      goal: 'ship the thing',
      state: 'ADMITTED',
      originScope: 'marketing',
      targetScope: 'engineering',
      deliverableSchema: 'release.v1',
      bid: { dollars: 12, tokens: 4000, humanMinutes: 30, deadline: '2026-09-10T12:00:00.000Z' },
      claimRefs: ['clm_a', 'clm_b'],
      createdAt: '2026-09-09T12:00:00.000Z',
      updatedAt: '2026-09-09T12:00:00.000Z',
    },
    { at: DAY_LATER, recordHref: '/console/requests/rq_2?return=%2Fconsole%2Finbox' },
  );
  const requestHtml = renderInspectorPanel(request);
  eq(requestHtml.includes('12 USD · 4,000 tokens · 30 human min'), true, 'the bid is the real bid:');
  eq(requestHtml.includes('clm_a'), true, 'cited claims are listed:');
  eq(requestHtml.includes('/console/claims/clm_a'), true, 'as links to the Ledger:');
  eq(requestHtml.includes('/console/requests/rq_2?return=%2Fconsole%2Finbox'), true, 'with a way out to the record:');
  // A day later, exactly: the age ladder rolls 1440 minutes into days rather
  // than printing "1440m" or rounding to "1d" from anything but the clock.
  eq(requestHtml.includes('1d ago'), true, 'and ages derived from the server clock:');
  eq(requestHtml.includes('data-inspect-copy'), true, 'the copy control ships with the panel:');
});

T('the shared table makes the title the trigger and keeps the id visible', () => {
  const html = inspectTable(
    ['Item', 'State'],
    [
      { target: { kind: 'request', id: 'rq_9' }, title: 'Ship it', sub: 'rq_9', cells: ['ADMITTED'] },
      { target: null, title: 'Synced from GitHub', cells: ['OPEN'] },
    ],
    (t) => inspectHref('/console/inbox', '', t),
  );
  eq(html.includes('data-inspect="request:rq_9"'), true, 'the title is the trigger:');
  eq(html.includes('rq_9'), true, 'the technical id stays visible:');
  // A row with no target is still readable — it just cannot open a panel.
  eq(html.includes('Synced from GitHub'), true, 'a non-inspectable row renders:');
  eq((html.match(/data-inspect=/g) ?? []).length, 1, 'and only the inspectable row links:');
});

T('an empty feed explains itself and offers a next step, never a bare "no data"', () => {
  const empty = {
    items: [],
    omitted: 0,
    considered: 0,
    counts: { decision: 0, blocked: 0, evidence: 0 },
    sources: ['requests', 'claims'] as string[],
    byTarget: {},
    requests: {},
    claims: {},
  };
  const html = renderFeedPage({ model: empty, tab: 'all' });
  eq(html.includes('Nothing in this filter needs attention.'), true, 'the absence is named:');
  eq(html.includes('An empty feed means none of those exist right now'), true, 'and explained:');
  eq(html.includes('/console/human-work'), true, 'with a next action:');
  eq(html.includes('No data'), false, 'never a bare "No data":');
  eq(html.includes('<table'), false, 'and no empty table header:');
  eq(html.includes('0 item(s) need attention'), false, 'a zero is not rendered as a count:');
});

T('the filter tabs are a closed set, and only real filters exist', () => {
  // Mention/Assigned/Following are deliberately absent: they need a durable read
  // state or subscription this product does not have.
  eq(resolveFeedTab(null), 'all', 'the default tab:');
  eq(resolveFeedTab('evidence'), 'evidence');
  eq(resolveFeedTab('mentions'), 'all', 'an unknown filter falls back to All rather than erroring:');
  eq(
    FEED_TABS.map((t) => t.key),
    ['all', 'decision', 'blocked', 'evidence'],
    'no speculative tab:',
  );
  // Each tab must resolve to itself — a tab the resolver does not know would be
  // a link that silently shows the wrong set.
  for (const t of FEED_TABS) eq(resolveFeedTab(t.key), t.key, `${t.key} round-trips:`);
});

T('ages render as durations, and an unreadable timestamp is a dash', () => {
  eq(fmtAge(0), '0m');
  eq(fmtAge(59), '59m');
  eq(fmtAge(60), '1h');
  eq(fmtAge(60 * 24 * 3), '3d');
  // Honesty: an unreadable timestamp is unknown, not "just now".
  eq(fmtAge(null), '—');
});

T('the inbox route declares session/html/activation and is read-only', () => {
  const routes = feedRoutes();
  validateRoutes(routes);
  const byId = new Map(routeManifest(routes).map((m) => [`${m.method} ${m.pattern}`, m]));
  eq(byId.size, Object.keys(FEED_CAPABILITIES).length, 'feed route count:');
  for (const [id, want] of Object.entries(FEED_CAPABILITIES)) {
    eq(byId.get(id)?.capability, want.capability, `${id} capability:`);
    eq(byId.get(id)?.surface, want.surface, `${id} surface:`);
    eq((byId.get(id)?.note ?? '').length > 0, true, `${id} has a stated reason:`);
  }
  // It names goals, scopes and evidence, so an un-activated account gets the
  // password form before the queue.
  eq(
    routes.every((r) => r.activation === 'required'),
    true,
    'every feed route requires activation:',
  );
  // Attention is read, not raised: a page that mutated the queue would be a bug.
  eq(
    routes.every((r) => r.method === 'GET' && r.body === undefined),
    true,
    'feed is read-only:',
  );
});

T('the inbox answers a session, refuses an anonymous browser, and filters honestly', async () => {
  const { db, ledger, coord, comp } = await fresh({ maxHumanEscalationsPerDay: 20, maxConcurrentPerScope: 99 });
  await installAuthSchema(db, NOW);
  await signupTenant(
    db,
    { slug: TEN, name: 'Acme', email: 'owner@acme.test', password: 'the-console-password', ownerName: 'Ada' },
    NOW,
  );
  try {
    // One item of each kind, through the same APIs the rest of the app uses.
    await coord.submit(base({ id: 'rq_waiting', goal: 'needs a decision', bid: { humanMinutes: 5 } }));
    const failed = await coord.submit(base({ id: 'rq_failed', goal: 'failed run' }));
    await coord.fail(TEN, failed.request.id, 'boom');
    await verifiedClaim(ledger, 'clm_inbox_stale');
    await ledger.markStale(TEN, DAY_LATER);

    const server = await startConsoleServer(db, ledger, coord, comp, { tenant: TEN, now: () => NOW });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      const anon = await fetch(`${baseUrl}/console/inbox`, { redirect: 'manual' });
      eq(anon.status, 303, 'anonymous redirects to the login form:');

      // Log in the way the other route tests do: scrape the form token first.
      const pre = await fetch(`${baseUrl}/login`, { redirect: 'manual' });
      const preCookie = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      const token = (await pre.text()).match(/name="csrf" value="([0-9a-f]+)"/)![1]!;
      const session = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { cookie: preCookie },
        body: `csrf=${token}&email=owner%40acme.test&password=the-console-password`,
        redirect: 'manual',
      });
      const cookie = (session.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

      const res = await fetch(`${baseUrl}/console/inbox`, { headers: { cookie } });
      eq(res.status, 200, 'the inbox renders for a session:');
      const html = await res.text();
      eq(html.includes('id="console-rail"'), true, 'it is shelled:');
      eq(html.includes('href="/console/inbox"'), true, 'the rail pins it:');
      eq(html.includes('needs a decision'), true, 'the waiting request is shown:');
      eq(html.includes('failed run'), true, 'the failed run is shown:');
      // The row leads with the human-readable subject, not the raw id: the id
      // rides behind it in mono (design.md copy law).
      eq(html.includes('subject:clm_inbox_stale'), true, 'the stale claim is shown:');
      // Every row selects itself. The panel is the way to the record, and the
      // selection is server-rendered, so this path works with JavaScript off.
      eq(html.includes('data-inspect="request:rq_waiting"'), true, 'the row selects the request:');
      eq(html.includes('data-inspect="claim:clm_inbox_stale"'), true, 'the row selects the claim:');
      eq(html.includes('vc-inspect-layout is-open'), false, 'and nothing is open by default:');

      // The deep link is the same page with the panel open. The panel holds the
      // exits — the authoritative record and the room — so the feed never has to
      // be the record itself.
      const deep = await (
        await fetch(`${baseUrl}/console/inbox?inspect=request%3Arq_waiting`, { headers: { cookie } })
      ).text();
      eq(deep.includes('vc-inspect-layout is-open'), true, 'a deep link opens the panel:');
      eq(deep.includes('needs a decision'), true, 'with the record it names:');
      eq(deep.includes('?return=%2Fconsole%2Finbox'), true, 'and a link to the authoritative record:');
      eq(deep.includes('/console/buzz/engineering'), true, 'plus the room the work lives in:');
      // A selection no read produced says so, rather than showing a blank panel or
      // — worse — a different record.
      const missing = await (
        await fetch(`${baseUrl}/console/inbox?inspect=request%3Arq_missing`, { headers: { cookie } })
      ).text();
      eq(missing.includes('Not shown in this view'), true, 'an unknown record is stated as unavailable:');
      const junk = await (await fetch(`${baseUrl}/console/inbox?inspect=rq_waiting`, { headers: { cookie } })).text();
      eq(junk.includes('vc-inspect-layout is-open'), false, 'a malformed target opens nothing:');

      // The fragment is the panel alone — never a second copy of the page.
      const fragment = await fetch(`${baseUrl}/console/inbox?inspect=request%3Arq_waiting&fragment=1`, {
        headers: { cookie },
      });
      eq(fragment.status, 200, 'the fragment is served:');
      const fragmentHtml = await fragment.text();
      eq(fragmentHtml.includes('vc-ins-title'), true, 'it is the panel:');
      eq(fragmentHtml.includes('vc-inspect-layout'), false, 'and not the page:');
      eq(fragmentHtml.includes('<html'), false, 'nor a document:');
      const noTarget = await fetch(`${baseUrl}/console/inbox?fragment=1`, { headers: { cookie } });
      eq(noTarget.status, 400, 'a fragment without a selection is a caller error:');

      // Tabs are real filters over the same model.
      const evidence = await (await fetch(`${baseUrl}/console/inbox?view=evidence`, { headers: { cookie } })).text();
      eq(evidence.includes('subject:clm_inbox_stale'), true, 'the evidence tab keeps the claim:');
      eq(evidence.includes('needs a decision'), false, 'and drops the decision:');
      eq(evidence.includes('aria-current="page"'), true, 'the active tab is marked:');

      const bogus = await (await fetch(`${baseUrl}/console/inbox?view=mentions`, { headers: { cookie } })).text();
      eq(bogus.includes('needs a decision'), true, 'an unknown filter shows All rather than an empty page:');

      // The approvals page keeps its queue and gains real tabs.
      const review = await (await fetch(`${baseUrl}/console/human-work`, { headers: { cookie } })).text();
      eq(review.includes('Needs review'), true, 'the review tab is present:');
      eq(review.includes('id="pending-review"'), true, 'and the approval queue still renders:');
      const completed = await (
        await fetch(`${baseUrl}/console/human-work?view=completed`, { headers: { cookie } })
      ).text();
      eq(completed.includes('No human work has settled yet.'), true, 'the settled tab is a real, empty filter:');
      eq(completed.includes('id="pending-review"'), false, 'and does not re-render the queue:');

      // The approvals page uses the same panel for its queue cards and its rows,
      // and the decision forms stay on the card where the contract put them.
      const reviewDeep = await (
        await fetch(`${baseUrl}/console/human-work?inspect=request%3Arq_waiting`, { headers: { cookie } })
      ).text();
      eq(reviewDeep.includes('vc-inspect-layout is-open'), true, 'the approvals page opens the same panel:');
      eq(reviewDeep.includes('data-inspect="request:rq_waiting"'), true, 'the queue card is a trigger:');
      eq(reviewDeep.includes('id="pending-review"'), true, 'and the decision forms stay on the card:');
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});
