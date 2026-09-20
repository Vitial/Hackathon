// Feed — `GET /console/inbox`.
//
// The route exists now, and only now: `redesign.md` §7.1 says the Feed may not
// get a route of its own "until its read model is defined", and `../feed.ts` is
// that read model. Everything the page shows comes from reads that already
// existed (request rows, claim rows); this module owns request handling and
// nothing else, and it writes nothing at all.
//
// Why not a `?tab=` on the legacy dashboard: the Feed is a different page with a
// different question, and stacking it onto the dashboard's tab dispatcher would
// have made every legacy tab a dependency of the new one. The legacy tab
// mappings and `/console/human-work` are untouched — this is additive, and a
// user who never visits `/console/inbox` loses nothing.
//
// Capability is declared here rather than remembered in a handler body: session
// only, because the page names goals, scopes and evidence, and `activation:
// 'required'` because an un-activated account has no business in the queue.

import type { ServerResponse } from 'node:http';
import { requireAuth, type AuthContext, type Capability, type RouteDef } from './registry.ts';
import type { AsyncDb } from '../../core/db.ts';
import type { Coordinator } from '../../coord/coordinator.ts';
import { buildFeed, feedPanel, renderFeedPage, resolveFeedTab } from '../feed.ts';
import { FRAGMENT_PARAM, INSPECT_PARAM, hrefWithoutInspect, parseInspect, renderInspectorPanel } from '../inspector.ts';

export interface FeedEnv {
  db: AsyncDb;
  tenant: string;
  coord: Coordinator;
  /** The shelled console page — supplied by the server, so this owns no chrome. */
  shellPage(
    auth: AuthContext,
    page: { title: string; body: string; navKey: string; hideHeader?: boolean; drawer?: boolean },
  ): Promise<string>;
}

const HTML = 'text/html; charset=utf-8';
const NO_STORE = { 'cache-control': 'no-store' } as const;

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'content-type': HTML, ...NO_STORE });
  res.end(html);
}

export function feedRoutes(): RouteDef<FeedEnv>[] {
  return [
    {
      method: 'GET',
      pattern: '/console/inbox',
      capability: 'session',
      surface: 'html',
      activation: 'required',
      note: 'Ranked, capped attention queue over existing request and claim reads, plus the contextual inspector for a selected row. Read-only: both renderings link to the authoritative record and never mutate it.',
      async handler(ctx) {
        const auth = requireAuth(ctx);
        const target = parseInspect(ctx.url.searchParams.get(INSPECT_PARAM));
        const tab = resolveFeedTab(ctx.url.searchParams.get('view'));
        const search = ctx.url.search || '';
        const model = await buildFeed({
          db: ctx.env.db,
          coord: ctx.env.coord,
          tenant: ctx.env.tenant,
          at: ctx.at,
          // Detail links carry this page (with its filter, and without the
          // selection) as their return target, so a record's Back lands on the
          // queue it came from rather than on a stale inspector URL.
          here: hrefWithoutInspect(ctx.path, search),
        });
        // The fragment rendering is the same page with the chrome and the list
        // left out: one route, one capability, one budget, and the inspector
        // script fetches exactly this when a row is selected with JavaScript on.
        if (ctx.url.searchParams.get(FRAGMENT_PARAM) === '1') {
          // A fragment with no selection is a caller error, not a page: the
          // script only asks for one when it has a target, and inventing a
          // panel for an unnamed record would be worse than a 400.
          if (!target) {
            ctx.res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            ctx.res.end('fragment=1 requires an inspect=<kind>:<id> target');
            return;
          }
          // The panel alone, never a whole page: the caller swaps this into the
          // layout it already rendered.
          ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          ctx.res.end(
            renderInspectorPanel(feedPanel(model, target, { at: ctx.at, here: hrefWithoutInspect(ctx.path, search) })),
          );
          return;
        }
        sendHtml(
          ctx.res,
          await ctx.env.shellPage(auth, {
            title: 'Inbox',
            navKey: 'inbox',
            hideHeader: true,
            body: renderFeedPage({ model, tab, path: ctx.path, search, inspect: target, at: ctx.at }),
          }),
        );
      },
    },
  ];
}

/** Capability + surface of each route, for the manifest test and reviewers. */
export const FEED_CAPABILITIES: Record<string, { capability: Capability; surface: 'api' | 'html' }> = {
  'GET /console/inbox': { capability: 'session', surface: 'html' },
};
