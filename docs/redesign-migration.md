# Console redesign — Phase 0 baseline and migration map

Status: living document · opened 2026-09-20
Owner: Console surfaces · Source of intent: `redesign.md`

`redesign.md` is the plan. This file is the Phase 0 artifact it asks for: a route
inventory, a component inventory, the token mapping, and the per-page migration
checklist. Section references like §4.4 point at `redesign.md`.

Two documents describe appearance and they answer different questions:

| File          | Answers                                                               |
| ------------- | --------------------------------------------------------------------- |
| `design.md`   | What the Console looks like — genre, palette, type, motion, copy law. |
| `redesign.md` | What the product should become — IA, surfaces, phases, acceptance.    |
| this file     | What exists today, what maps where, and what is left to migrate.      |

---

## 1. Guardrails (redesign.md §12.2)

A presentation and information-architecture migration. The following are **not**
touched by any phase below, and a change to one of them is a separate,
explicitly approved task:

- Authentication, session handling, login/MFA/recovery, invitation acceptance.
- CSRF checks, capability evaluation, tenant scoping.
- Audit writes, retention and erasure semantics, export behavior.
- Approval state transitions, workflow execution contracts, optimistic locking.
- The public home page (`site/`).

Hard structural constraint: **Console and Buzz stay two shells.** Console chrome
is `renderConsoleShell` / `vc-*`; Buzz chrome is `renderWorkspaceShell` /
`buzz-*` and carries `data-vital-no-theme`. Neither imports the other, and Buzz
does not inherit `var(--v-*)`. `serve.ts` branches once on `navKey === 'buzz'`.
This is enforced today and is not up for renegotiation during this redesign.

---

## 2. Route inventory

### 2.1 Declared in the route table

The route table (`src/console/routes/*.ts`, registry in `registry.ts`) is the
authoritative, enumerable manifest: each entry declares `capability`, `surface`
and body policy, and the `*_CAPABILITIES` maps are pinned by
`test/routes.test.ts`. Enumerated 2026-09-20:

| Route                                                      | Capability / surface | Target group (redesign.md §4)            |
| ---------------------------------------------------------- | -------------------- | ---------------------------------------- |
| `GET /healthz`                                             | public / api         | — (not a user surface)                   |
| `GET /api/health`                                          | public / api         | —                                        |
| `GET /api/approval-latency`                                | session / api        | Feed (metric source)                     |
| `GET /api/cost-per-signal`                                 | session / api        | Feed (metric source)                     |
| `GET /console/inbox`                                       | session / html       | Feed (phase 2)                           |
| `GET /console/requests`                                    | session / html       | Work                                     |
| `GET /console/claims`                                      | session / html       | Ledger                                   |
| `GET /console/rooms`                                       | session / html       | Rooms (Buzz-owned view of Console rooms) |
| `GET /console/human-work`                                  | session / html       | Feed → Approvals                         |
| `POST /api/requests/:id/refresh-evidence`                  | session / api        | Work (mutation)                          |
| `GET /console/audit`                                       | owner / html         | Governance                               |
| `GET /console/data`                                        | owner / html         | Governance                               |
| `GET /console/data/export`                                 | owner / html         | Governance                               |
| `POST /console/data/erase`                                 | owner / html         | Governance                               |
| `GET /console/learning/compile`                            | owner / html         | Systems                                  |
| `POST /console/learning/compile`                           | owner / html         | Systems (owner-gated promotion)          |
| `POST /console/learning/cards/:id/transfer-test`           | owner / html         | Systems                                  |
| `GET /console/agent-tasks`                                 | session / html       | Work → Agent tasks                       |
| `GET /console/agent-tasks/:id`                             | session / html       | Work → Agent tasks                       |
| `GET /console/agent-tasks/:id/feed`                        | session / api        | Work (polling)                           |
| `GET /console/review`                                      | session / html       | Work → Review                            |
| `POST /console/review`                                     | session / html       | Work → Review (mutation)                 |
| `GET /console/review/:missionId`                           | session / html       | Work → Review                            |
| `POST /console/review/:missionId`                          | session / html       | Work → Review (mutation)                 |
| `GET /console/issues`                                      | engineer / html      | Work → Issues                            |
| `GET /console/issues/sync`                                 | engineer / api       | Work → Issues (GitHub sync)              |
| `GET /console/issues/detail`                               | engineer / api       | Work → Issues                            |
| `POST /console/issues/{create,move,update,delete,comment}` | engineer / api       | Work → Issues (mutations)                |

### 2.2 Legacy dispatcher branches (not yet in the route table)

Still served from the `serve.ts` chain. They are covered by the redesign map and
must keep working; declaring them in the route table is separate work (their
capabilities are currently expressed in the handler bodies, which is exactly the
problem `registry.ts` exists to solve).

| Family                  | Representative paths                                                                                                                                                                                | Target group                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Auth entry              | `/login`, `/login/mfa`, `/signup`, `/forgot-password`, `/reset-password`, `/accept-invite`, `/verify-email`, `/change-password`                                                                     | Auth layout (own layout, no rail)                             |
| Erasure receipts        | `/receipts/erasure`, `/receipts/erasure/:id`                                                                                                                                                        | Governance (receipt, read-only)                               |
| Account                 | `/account`, `/account/email/request`, `/account/password`, `/account/mfa/*`, `/logout`                                                                                                              | Governance → Account/security                                 |
| Overview + legacy tabs  | `/console`, `/console/`, `/console/dashboard` (`?tab=home\|approvals\|ledger\|workflows\|governance\|activity\|world\|economics\|learning`)                                                         | Feed / Ledger / Systems / Governance (tab mappings preserved) |
| Digest                  | `/console/digest`                                                                                                                                                                                   | Systems                                                       |
| Learning                | `/console/learning`, `POST /console/learning/label`                                                                                                                                                 | Systems                                                       |
| Compiler                | `/console/compiler`                                                                                                                                                                                 | Systems                                                       |
| Buzz / Rooms            | `/console/buzz`, `/console/buzz/:scope`, `/console/rooms`                                                                                                                                           | Rooms (Buzz shell)                                            |
| Issues + GitHub         | `/console/issues`, `/console/issues/github/{config,authorize,sync,unlink,webhook}`                                                                                                                  | Work → Issues                                                 |
| Meetings                | `/console/meetings`, `/console/assets/meeting-room.{css,js}`, `POST /api/meetings/create`, `GET /api/meetings/list`                                                                                 | Work → Meetings (live room is Buzz-adjacent)                  |
| Workflows               | `/console/workflows`, `/console/workflows/:id`, retry/cancel/outcome actions                                                                                                                        | Work / Systems                                                |
| Requests + deliverables | `/console/requests/:id`, version and deliverable detail, `?return=`                                                                                                                                 | Work                                                          |
| Claims + decisions      | `/console/claims/:id`, decision/outcome/replay surfaces                                                                                                                                             | Ledger                                                        |
| Setup                   | `/setup`, `/setup/rooms`, `/setup/test-source`, `/setup/ingest`, `/setup/sample`, `/setup/start-release`                                                                                            | Governance → Setup                                            |
| Team                    | `/team`, `/team/operations`, `/team/invite`, `/team/invitation/{resend,revoke}`, `/team/reactivate`, `/team/team`, `/team/role`, `/team/transfer-ownership`, `/team/disable`, `/team/stops/recover` | Governance → Team                                             |
| APIs                    | `/api/events`, `/api/metrics`, `/api/audit`, `/api/ledger/export`, `/api/erasure/receipt`, `/api/learning/*`, `/api/buzz/*`                                                                         | — (transport; consumed by pages above)                        |

Exit criterion §11 Phase 0: no family above is unmapped, and every mapped row
keeps its current URL, capability and mutation contract.

---

## 3. Navigation map (Phase 1 — implemented)

The Console rail (`renderConsoleShell`) now groups the user's operating loop
instead of implementation modules:

| Group          | Items (label → route, rail key)                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feed**       | Inbox → `/console/inbox` (`inbox`, phase 2) · Overview → `/console/dashboard` (`dashboard`) · Approvals → `/console/human-work` (`approvals`, real pending count)                                                                                    |
| **Work**       | Requests → `/console/requests` (`requests`) · Agent Tasks → `/console/agent-tasks` (`agentTasks`) · Meetings → `/console/meetings` (`meetings`) · Code review → `/console/review` (`review`) · Issues → `/console/issues` (`issues`, engineers only) |
| **Ledger**     | Ledger → `/console/dashboard?tab=ledger` (`ledger`) · Claims → `/console/claims` (`claims`) · Activity → `/console/dashboard?tab=activity` (`activity`)                                                                                              |
| **Systems**    | Workflows → `/console/dashboard?tab=workflows` (`workflows`) · Compiler → `/console/compiler` (`compiler`) · Learning → `/console/learning` (`learning`) · Digest → `/console/digest` (`digest`)                                                     |
| **Governance** | Governance → `/console/dashboard?tab=governance` (`governance`) · Audit (`audit`) · Data (`data`) · Team (`team`) · Setup (`setup`) · Account (`account`)                                                                                            |

Rules this change keeps:

- **No href was renamed and no route key was removed.** Every link above already
  worked; the regroup moved entries between groups and added two pins
  (`Requests`, `Claims`) that were previously reachable only from another page.
- **`Rooms` is not in the Console rail.** Rooms belongs to the Buzz shell
  (`redesign.md` §5.1, `design.md` "Two surfaces"). The single topbar Chat
  bridge is the way across.
- **Counts are actionable only.** The only badge in the rail is the real pending
  approval count summed from room health; zero renders nothing.
- **Active state** is `aria-current="page"` plus an accent-tinted row, and every
  key in `RAIL_KEYS` still resolves. `topbar` title and rail label agree
  (`dashboard` → "Overview").
- **Legacy keys** (`humanWork`, `rooms`, `buzz`, `activity`, …) still render and
  still highlight; nothing was deleted from `RAIL_KEYS` / `titleFor`.
- The hidden `aria-label="Console"` compatibility nav from `render.ts`
  (`buildConsoleNav`) is untouched — it is the FLOW-019 keyboard contract and a
  test target.

Not in this phase (deliberately): a Feed route, a global search backend, the
command palette, saved views, an inspector drawer, and any Buzz change. Each
needs a read model or storage contract before it exists (see §5 and
`redesign.md` §11).

---

## 4. Component inventory

### 4.1 What already exists and is reused

| Concern                                                                  | Implementation                                |
| ------------------------------------------------------------------------ | --------------------------------------------- |
| Console shell (rail, top bar, surface, bottom nav, spotlight, ⌘K focus)  | `src/console/console-shell.ts`                |
| Buzz shell (room roster, thread, unread, composer)                       | `src/console/workspace-shell.ts`              |
| Token sheet (both themes, stage palette, glass, motion, focus)           | `src/console/theme.ts`                        |
| Document boundary + theme injection / opt-out                            | `themeDocument`, `buzzDocument` in `serve.ts` |
| Shared page states (skip link, error summary, sentence-form empty, etc.) | `src/console/states.ts`                       |     | `PageHeader`, `SectionHeader`, `StatusChip`, `RiskBadge`, `EmptyState`, `ErrorState`, `Timeline` + the tone maps | `src/console/components.ts` (§9.3) |
| KPI / metric card                                                        | `src/console/components.ts`                   |
| Detail document + back target + evidence pagination                      | `src/console/detail.ts`                       |
| Review queue + operator fields (approvals)                               | `src/console/review.ts`                       |
| Shell telemetry (tenant-wide, grouped — never per-room loops)            | `src/console/shell-metrics.ts`                |
| Legacy console nav + account cluster + detail URLs                       | `src/console/render.ts`                       |
| List-page renderer                                                       | `src/console/routes/lists.ts`                 |

### 4.2 What each phase still has to build

From `redesign.md` §10, mapped to its phase so nothing is built speculatively:

| Component                                                                                                              | Phase                    | Precondition                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FeedModel` / `renderFeedPage` (ranked attention)                                                                      | 2 — **done**             | `src/console/feed.ts`; reads only existing request + claim rows                                                                                                                     |
| `PageHeader`, `StatusChip`, `EmptyState`, `Timeline`/`ActivityFeed`                                                    | 3 — **done**             | `components.ts` (§9.3); no new data, no new query                                                                                                                                   |
| `SectionHeader`, `RiskBadge`, `ErrorState`                                                                             | 3 — **done**             | `components.ts` §9.3; `states.ts` now delegates its failure vocabulary to `errorState`                                                                                              |
| `Breadcrumbs`, `OwnerAvatarGroup`, `ActivityFeed`, `RecordSummary`, `RelatedRecords`, `BulkActionBar`, `ConfirmDialog` | 3–7                      | Each needs a surface that actually has two levels / owners / related records; none is invented ahead of one                                                                         |
| `InspectorDrawer`, `DataTable`                                                                                         | 2–3 — **done**           | `src/console/inspector.ts`; client-side enhancement only, the server render stays authoritative                                                                                     |
| `FilterBar`, `ViewSwitcher`                                                                                            | 2–3                      | Each surface keeps its own filter state in the URL today; a shared bar arrives when a second surface needs the same one                                                             |
| `CommandPalette`, `GlobalSearch`                                                                                       | 1–2                      | Must reuse existing routes/queries; no new search backend without a contract                                                                                                        |
| `SavedViewControl`                                                                                                     | after 3                  | Needs saved-view persistence                                                                                                                                                        |
| `Board` (drag-and-drop)                                                                                                | 3                        | Only for authorized transitions with a keyboard/menu alternative                                                                                                                    |
| `ContextPanel` in Buzz (`buzz-*`)                                                                                      | 6 — **first slice done** | §9.2: references come from the conversation itself, so no record-link table was needed; per-kind authorization is applied to the read                                               |
| `RecordLinkChip` in Buzz                                                                                               | 6 — **done**             | §9.2: the message text **is** the store. The chip is derived from it, so it survives a relay copy, an export and a hand-pasted link; the composer picker only writes that same link |
| `Board` in Buzz                                                                                                        | 6                        | Only for authorised transitions, with a keyboard/menu alternative                                                                                                                   |
| `ConfirmDialog`                                                                                                        | 7                        | Wraps existing CSRF + typed-confirmation contracts; never replaces them                                                                                                             |

---

## 5. Token specification

`redesign.md` §6.1/§6.2 propose a semantic palette. Mapped against the shipped
sheet (`theme.ts`), **the Console role palette already exists — no new tokens are
required for Phase 1**, and none were added:

| `redesign.md` role    | Shipped token                                                  | Value (dark / light)                |
| --------------------- | -------------------------------------------------------------- | ----------------------------------- |
| Canvas                | `--v-bg-0`                                                     | `#111111` / `#F7F8F6`               |
| Surface               | `--v-bg-1`                                                     | `rgba(22,22,22,.82)` / `#FFFFFF`    |
| Raised surface        | `--v-bg-2`                                                     | `rgba(255,255,255,.05)` / `#F2F4F1` |
| Elevated surface      | `--v-bg-3`                                                     | `rgba(255,255,255,.09)` / `#E9ECE8` |
| Primary ink           | `--v-ink`                                                      | `#F3F3F3` / `#111315`               |
| Secondary ink         | `--v-ink-2`                                                    | `#D6D6D6` / `#3F4643`               |
| Muted ink             | `--v-muted`                                                    | `#9A9A9A` / `#68706D`               |
| Hairline              | `--v-line` (`-strong`)                                         | `rgba(255,255,255,.1)` / `#E5E8E5`  |
| Vital accent          | `--v-accent`                                                   | `#D9FFA8` / `#126B52`               |
| Verified / healthy    | `--v-fact`                                                     | `#9BE08C` / `#278A59`               |
| Pending / provisional | `--v-hypo`                                                     | `#E8C07A` / `#D99A32`               |
| Risk / halted         | `--v-risk`                                                     | `#E87A70` / `#D95C52`               |
| Prediction / info     | `--v-pred`                                                     | `#8AA4D8` / `#5577B8`               |
| Status washes         | `--v-tint-{good,warn,risk,info}-{bg,ink}`, `--v-tint-prose-bg` | per theme                           |
| Focus ring            | `--v-focus`                                                    | == accent                           |

Rules carried into implementation: the accent marks actions and current location
only (never a chart series); semantic colour never travels without a label or
icon; missing data renders `—`, never a zero; and Buzz keeps its own literal
palette (`buzz.ts`, `workspace-shell.ts`), which is a deliberate exemption, not
debt (`test/tokens.test.ts` enforces both halves).

Typography: resolved in favour of the rendered stack — Outfit + JetBrains Mono.
`design.md` previously named Inter in two places; both now read Outfit, and
`theme.ts` is named there as the implementation source of truth
(`redesign.md` §20 decision 9).

---

## 6. Screenshot baseline

Not yet captured. The capture list is `redesign.md` §16; the workflow is to boot
the app against seeded data and shoot both themes, desktop and mobile, before and
after each phase (Console overview, approvals, requests, claims, workflow detail,
Buzz room, plus the legacy-tab URLs). Recorded here as an open task rather than
claimed as done — there is no automated screenshot suite in this repo today.

---

## 7. Per-page migration checklist (redesign.md §12.4)

Applied in this order, one page at a time, verifying after each step:

1. Keep the existing query and mutation path untouched.
2. Replace page-level layout with the shared page body.
3. Replace local styles with `var(--v-*)` tokens.
4. Add the inspector / view switcher where it earns its place.
5. Add deep-link state and preserve the return path.
6. Add responsive behavior (three columns → two → one; tables → stacked records).
7. Delete obsolete styles only after the route and its tests stay green.

Verification after each page: `npm run typecheck`, `npm test`, `npm run lint`,
plus the route checks in `test/routes.test.ts` (shell present, capability
unchanged, statement budget unmoved) and the targeted browser test where one
exists.

---

## 8. Open decisions (redesign.md §20)

| #   | Decision                                     | Resolution taken                                                                                                                                                                                                                       |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Feed from existing routes, or a new route?   | Resolved in phase 2: the read model is defined first (`src/console/feed.ts`), then `/console/inbox` was added as its own route. `/console/dashboard` and `/console/human-work` keep their legacy contracts and their `?tab=` mappings. |
| 2   | Keep the existing accent/token architecture? | Yes. No token was added or changed (see §5).                                                                                                                                                                                           |
| 3   | Which Buzz appearance is the contract?       | Unchanged for now. Phase 6 does not touch Buzz's palette; the contract question stays open and out of this slice.                                                                                                                      |
| 4   | Inspector open by default?                   | After selection only, and now implemented (§9.1): a `?inspect=` selection renders the panel server-side beside the list, and with JavaScript it opens without navigating, so position and filters survive.                             |
| 5   | Which metrics are authoritative?             | Only the ones already rendered from real reads; the rail badge uses the real pending-approval count and nothing else was added.                                                                                                        |
| 6   | Saved views in the first release?            | No. Requires persistence.                                                                                                                                                                                                              |
| 7   | Contextual Buzz threads first?               | Requests, Approvals, Claims, Decisions, Issues — once record linking exists.                                                                                                                                                           |
| 8   | Workspace switcher?                          | Omitted. There is no multi-workspace state, so it would be a dead control.                                                                                                                                                             |
| 9   | `design.md` typography conflict?             | Resolved to Outfit; `design.md` updated.                                                                                                                                                                                               |

---

## 9. Phase 2 status — Feed / Inbox, the review layout, and the inspector

Shipped

- **`src/console/feed.ts`** — the read model. Three sources, all pre-existing:
  requests awaiting a human decision (via `awaitingHumanReview`, the _same_
  predicate the approval queue filters with, now exported from `review.ts`),
  requests that did not deliver (`DENIED`, `FAILED`, `TERMINATED_BUDGET`,
  `EXPIRED`), and ledger claims in `DISPUTED` or `STALE`. No notifications
  table, no read-state column, no second copy of any record.
- **Ranked and capped.** Decisions, then blocked work, then contested evidence;
  oldest first inside a kind. The cap is 40 and withheld items are _counted_, so
  the page says how many it did not show.
- **`GET /console/inbox`** (`src/console/routes/feed.ts`) — declared in the route
  table as `session`/`html` with `activation: 'required'`, read-only, and
  budgeted in `test/routes.test.ts` at 17 statements.
- **Filter tabs** over the same model (`All`, `Decisions`, `Blocked`,
  `Evidence`). An unknown `?view=` falls back to All rather than erroring. No
  `Mentions`/`Assigned`/`Following` tab exists, because no durable read state or
  subscription backs one.
- **Review context (§7.4 item 5).** `renderReview` now counts the uncertainty it
  actually observed while reading evidence — sources that would not load, and
  cited claims that are disputed or stale — and states it above the actions
  instead of leaving the reviewer to infer it. The approval contract itself
  (CSRF, optimistic locking, the explicit `confirmed` checkbox, decline reason,
  operator secret/signature, audit receipt) is untouched.
- **`/console/human-work` tabs.** `Needs review`, `Open work` and `Completed` are
  three filters over the one `coord.list` read; each link preserves the current
  search; each row now links to its room in Buzz. The queue renders on the tab
  that owns it, so arriving from the rail is unchanged.

Not shipped, and why

- The queue-left / context-right review split: needs `InspectorDrawer`.
- "What the system recommends" and "why": no recommendation exists in the stored
  model. Rendering one would be fabrication, so the review context shows the
  decision required, the evidence, and the uncertainty — and stops there.
- Mentions and unread state: no durable notification or read-state source.
- Snooze/defer controls: no deferral contract on the feed.

### 9.1 The inspector and the shared table (redesign.md §5.5, §6.8 I)

Shipped: `src/console/inspector.ts` — the one contextual panel, and the one
place its contract is written down. It is rendered on every surface that can
inspect (with the panel empty and the layout closed) so a client-side open has
somewhere to go; the selection is `?inspect=<kind>:<id>`, deep-linkable and
server-rendered, so the feature works with JavaScript off. There is no
framework and no dependency: the enhancement intercepts the trigger click,
fetches the same route's `?fragment=1` panel, and pushes state, so the document
is never navigated — which is what makes "closing loses neither filters nor
scroll" true rather than aspirational. A failed fragment fetch navigates to the
deep link instead of leaving a half-open panel.

A panel is a **view** of a record that lives elsewhere: it renders only fields
the row already read and links out. It adds no query, which is why the statement
budgets in `test/routes.test.ts` are unmoved by this phase.

| Surface                | Table                        | Trigger                               | Panel                                              |
| ---------------------- | ---------------------------- | ------------------------------------- | -------------------------------------------------- |
| `/console/inbox`       | `renderFeedPage` row list    | the row's title                       | `requestPanel` / `claimPanel` / `unavailablePanel` |
| `/console/requests`    | `inspectTable`               | the row's title                       | `requestPanel`                                     |
| `/console/human-work`  | `inspectTable` + queue cards | the title and the card's inspect link | `requestPanel`                                     |
| `/console/agent-tasks` | `renderAgentTaskList` rows   | the task title                        | `requestPanel`                                     |
| `/console/issues`      | the **list** view's rows     | the row's title                       | `issuePanel`                                       |

Two resolutions worth recording, because both were choices and not accidents:

- **Agent Tasks rows** open a request panel whose fields are the ones the task
  already read, and whose summary says it is an agent-task view of that request.
  Nothing is re-read to fill a panel.
- **Issues** keeps its board markup. The kanban is a drag surface and its list is
  kept in step with it by the module's own client script, so forcing the shared
  `<table>` over that list would fork the row markup between the server render
  and the live sync. The list is therefore _the table surface_ — its rows are
  inspector triggers, and `renderIssuesBoard` takes `view` so a selected issue is
  shareable in the view that shows it. Board cards are deliberately **not**
  triggers: a card is dragged, and a drag that is also a link is a bug waiting
  to happen; a card click still opens the board's own editor drawer, and the
  panel's single exit (`data-issue-open`) hands the human to that same drawer,
  with a real board URL underneath it for the no-JavaScript case.

### 9.2 Buzz record context panel (redesign.md §8.2, §10 Phase 6)

Shipped: `src/console/buzz-context.ts`, plus a region of the **Buzz shell**
(`workspace-shell.ts`) rather than of the room body. The room still says what its
own conversation references — only it knows — but it hands that region _up_:
`renderBuzzRoom` returns `{ body, contextPanel }`, a Buzz surface with no panel
supplies none (and then its stylesheet is not emitted either), and the shell owns
where the region sits, how it collapses, and the swap below.

**Links open the panel.** A reference is a real URL on the room —
`?open=request:rq_1` — so the same click server-renders the opened record, and the
shell's script upgrades that click into a fetch of `?panel=…` (the region alone,
via `renderBuzzRoomContext`: two reads instead of the page's twenty), a swap, and
a `pushState`, so back and forward move between panel states rather than reloading
the room around them. Record links inside message bodies carry the same
`data-buzz-panel-open` attribute but keep the Console as their own `href`: with
script they open beside the conversation, without it they go exactly where they
always went. The digest keeps a labelled Console exit per card (that is where a
record is _acted on_), and a failed swap follows the link rather than leaving a
dead click. A selection the cap left out, or a deep link to a record this room
never linked, is read on its own — one statement — and an unreadable one is still
opened, saying why it is empty.

**Where the references come from.** `redesign.md` gates this phase on
"record-link storage and authorization". No storage was added, because none was
needed for this half of it: a reference is read from the messages the room has
already loaded — `/console/requests|claims|issues/<id>` links in the body, the
`?inspect=` deep link the Console itself uses, and the request a **review card**
carries in its tag rather than in its text. So the panel cannot disagree with the
conversation above it, and there is no tagging UI, no link table and no second
copy of a record to keep in step. What is still gated is the _other_ half: a chip
attached to a message someone is about to send has nowhere to live yet.

**Cost.** A swap costs the region, not the page: the fragment answers in eight
statements where the room page costs thirty-one, and — checked in a browser — a
click on a record link leaves the conversation, its scroll and its composer
exactly where they were, with no navigation at all. One read per kind that has
references, batched by id
(`searchRequests`/`searchClaims` grew an `ids` filter; `getIssuesByIds` was added
to `issues.ts` because it owns that table), and **no reads at all for a room that
links to nothing** — a digest must not cost a statement per record, and an idle
room must not pay for a panel with nothing in it. The panel itself always renders,
with an honest empty state, so it does not appear and disappear as a room warms
up. References are capped at 10 (newest first, since that is what the room is
talking about now) and the count withheld is stated.

**Authorization.** The Issues half is gated on the viewer's department — the
same gate as the board, never role. A viewer without it does not merely get
refused after the read: the read is not issued, and the entry says why. Any other
reference that cannot be read (removed, or another organization's) keeps its link
and states that its context is unavailable, because the reference came from a
message the viewer can already read — dropping it would make the panel disagree
with the conversation, and filling it in would be worse than both.

**Boundary.** Everything is `--buzz-*` in `buzz-*` chrome, with Buzz's own
state→tone ramp (the Console's `requestTone` is deliberately _not_ reused: the two
surfaces share a state's meaning and share no token). The room page still defines
and uses no Console token, which `test/buzz-record-context.test.ts` asserts the
same way the surface-split test does.

**The record-link chip (redesign.md §8.2), and where it is stored.** A record
attached to a message is stored **in the message text** — the canonical Console
link — and the chip is _derived_ from it (`recordRefsFromMessage`, the per-message
half of the same extraction the panel uses). This is the decision worth recording:
the alternative, a `links_json` column, would have had the relay-published copy of
a message lose its attachment, an export drop it, and a hand-pasted link stay
unattached — three ways for one message to have two readings. The text is what
travels, so it is what a chip is read back from.

Two halves, one source:

- **On the message.** `renderRecordRefChips` prints a strip under every message
  (and every reply) that carries references, using the entries the room already
  read for the panel — so a chip costs no statement, and a message sent long
  before this existed gets chips too. A record the viewer cannot read, or one the
  panel's cap left out, still gets a chip: dashed, labelled with its id, tooltip
  carrying the reason. A reference is never silently unlinked.
- **In the composer.** `renderAttachPicker` offers the records the room has
  already read as chips that write that same link into the message at the caret
  (`[subject](href)`). It is rendered `hidden` and unhidden by the room's script:
  with JavaScript off there is no way to insert into the field, and a control that
  does nothing is worse than none. A record the room has never seen is attached by
  pasting its link — same result, because the chip comes from the text.

### 9.3 Shared page primitives (redesign.md §14, §12.4)

Shipped in `src/console/components.ts`: `pageHeader`, `sectionHeader`,
`statusChip`, `riskBadge`, `emptyState`, `errorState`, `timeline` / `timelineItem`,
and the tone maps they feed (`Tone`, `TONE_CLASS`, `requestTone`, `claimTone`,
`issueTone`, `roomTone`, `toneOf`). Each shape was being written out by hand on
page after page; each is now rendered in exactly one place.

**One mapping, not one per surface.** The state → tone mappers moved _into_ the
components module from `inspector.ts` (which re-exports them, so nothing that
reached for them through the inspector broke). That is the point of the move: the
Inbox, a Requests list cell, a claim table and an inspector chip now agree about
what `DENIED` looks like, because there is one function deciding it. `TONE_CLASS`
is the only place a tone becomes a `.v-badge-*` class, so a tone cannot render
unstyled. `toneOf` exists for data that carries its tone as a bare string
(`agent-tasks.ts` derives `tone: ''` for neutral) — anything unrecognised is
neutral rather than a class that does not exist.

**What each primitive guarantees.**

- `pageHeader` — eyebrow, title, one-sentence purpose, the caller's own actions
  placed (never invented), and the count line. Escaped throughout.
- `statusChip` — a tone, a dot or a pulse, and the state's _own word_: the label
  is always rendered next to the dot, so no chip depends on colour alone.
- `emptyState` — the absence named, what it means, and the way out. A title alone
  is a valid empty state; nothing is invented to fill one.
  `states.ts` keeps its one-sentence `emptyState(kind, …)` for an empty _inside_ a
  table or form; the block here is the page-level one.
- `sectionHeader` — a heading inside a card, with its sub-line and action slot
  placed consistently. `sub` is escaped; `subHtml` is markup the caller owns, for
  a sub that names a field or an authority (`<code>vital status</code>`). The page
  head is `pageHeader` and this is the section head, so the two are not
  interchangeable.
- `riskBadge` — an _assessment_, deliberately not the status chip: a chip repeats
  a record's own state, a risk badge assesses it, and the spec asks for the badge
  to lead with a glyph while colour stays supporting (redesign.md §6.8 H). Levels
  are `low` / `watch` / `blocked` — `low` exists so a clean card states that it is
  clean rather than omitting the badge — the domain label may override the level's
  own word (`3 gaps`, `stalled`, `trusted`), and the reasons become the tooltip
  because an attention badge with no reason is a mystery.
- `errorState` — what failed, what survived, and the named way forward. Every
  alert `states.ts` exports (stage failure, 403, timeout, destructive confirm,
  field summary) is this shape and now delegates here, which is also why
  `errorSummary` keeps its `data-error-summary` focus target: it is an option on
  this one block, not a second renderer.
- `timeline` / `timelineItem` — the chronological row. `timeline` renders a list
  of exactly `timelineItem`'s output, and `test/components.test.ts` pins that
  equality, because the alternative is the drift this replaced: the agent-task
  detail page rendered rows with a timestamp, its poller re-rendered them without
  one. The poll payload now carries the **rendered** rows (`html`, alongside the
  unchanged `feed` data), so the client splices markup it was handed instead of
  holding a second copy of the structure. `TASK_FEED_EMPTY` is shared for the same
  reason.

**What was migrated.** `renderListPage` (so Requests, Claims, Approvals and Rooms
all get it at once), the Inbox, the agent-task list and detail, the approval
queue's empty state, the Rooms table's status and pending/stop chips, the
operations dashboard's room status, and the dashboard's room status cell. The
Issues board keeps its own `iss-*` chrome on purpose — it is a kanban with its own
documented visual system (redesign.md §5.4) — but its list view is the shared
`inspectTable`, so the surface that _is_ shared is shared.

**The kanban's own chrome, the shared reading of state.** The board was also
keeping a fourth answer to "what colour is `IN PROGRESS`": a private `STATE_DOT`
map and the SVG ring it filled (`statusIndicatorSvg`). The column head, the list
group header and a list row now render `statusChip(state, …)` toned by
`issueTone`, so the board and the inspector panel cannot disagree about a state
it is the same state in. What legitimately stays board-owned is everything that
is _not_ a state: the drag, the columns, and the priority and label pills. The
head still sets its own type for its count and dashes; the chip is explicitly
insulated from the head's uppercase and tracking, because a chip is not a
heading's text.

The board re-renders rows in the browser during live sync, and that builder was a
second copy of the row — so the script is now handed the server's own chips
(`var STATE_CHIP`, the same call, serialized) and splices those. Asserted in
`test/components.test.ts` against `statusChip` itself, not against a copy of its
markup.

**The card's own assessment.** A card can also be _late_, or _stalled_, and neither
is a state: `issueRisk` (in `issues.ts`) reads a card against the board's clock
and returns readings, rendered with `riskBadge` — `watch` for a due date that has
passed, `blocked` for no update in `STALL_DAYS` (14). A `DONE` card is neither,
which is the whole reason this is an assessment _over_ the state: the same card can
be finished and overdue, and the board should say the first and not the second.

The two-badge decision is the snapshot's, not the view's: `IssueSnapshot.risk`
carries `issueId → rendered badges`, and the page's script is handed the same map
(`var ISSUE_RISK`, replaced on every sync response). A badge is an assessment of
_now_, so a card moved to `DONE` has to be able to lose it without a reload — and
a second implementation of "stalled" in the browser would be exactly the drift
this board has already been bitten by. `test/issues-panel.test.ts` asserts the
card's rendered badge string _equals_ the map entry the script holds.

One real bug fell out of this: `extractDueDate` matched `[0-9a-zA-Z\s]+`, so
`due: 2026-09-18` was read as `2026` — the card had been showing a year where the
author wrote a day, and any measurement of it would have been 1 January. The
separators are in the class now (`[0-9a-zA-Z\s:./-]`), on both the server read and
the client rebuild, and the test pins the full date on the card.

**Third batch — the tone guards, and the audit that closed the set.** The state →
tone maps were still missing for six vocabularies that each page had been
answering for itself, so `components.ts` gained `accountTone`, `invitationTone`,
`reviewTone`, `configSourceTone`, `readinessTone` and `skillCardTone`. What that
replaced:

| surface                           | was                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `routes/review.ts`                | a local `STATUS_TONE` map and a class built by concatenation; an unknown status took the info tint by string default |
| `agent-tasks.ts` (review link)    | a `COMPLETED ? good : info` ternary — the same status the review index tints, decided separately                     |
| `serve.ts` (account, invitation)  | two status ladders written out as markup in `statusLabel` / `invitationLabel`                                        |
| `serve.ts` (stops, config source) | a chip with a tone passed as a _class suffix string_ (`' v-badge-warn'`)                                             |
| `serve.ts` (readiness pills)      | a hand-drawn chip with its own 6px dot and raw `--v-fact` / `--v-risk` / `--v-faint` backgrounds                     |
| `serve.ts` (compiler gap list)    | a skill card's ladder state in a _neutral_ badge, i.e. a tone nobody had decided                                     |
| `deliverable.ts`                  | a grounding verdict as a sentence painted `--v-fact` / `--v-risk`, with no badge at all                              |
| `serve.ts` (account nav)          | the last tone class written out by hand                                                                              |

`test/tokens.test.ts` now guards the property rather than the instances: outside
`theme.ts` and `components.ts`, **no module names a `.v-badge-*` tint, or builds
one by concatenation**. That guard is absolute — it has no exemption list — which
is why the last two hand-written chips (`statusChip` with an `aria-current`
attribute for the current tab, and the human-decision page) were migrated with it.

What the audit found and deliberately **left**: the metadata chips (a notice
count, a bot actor, a role, a settings area, an ordinal, an `aria-current` nav
item) are hand-built with the neutral class and an inline size, because they are
not states and the primitive has no size option; `code-review.ts`'s file-status
letters and the meeting room's palette are their own documented visual systems,
like the kanban's chrome; `journey.ts`'s ramp is progress rather than a state;
and `render.ts`'s tier colours are tiers.

**Second batch.** `sectionHeader` replaced the hand-written heads in the agent
view, the compiler view, the code-review page and the data page (including the
risk-toned danger heading, which no longer needs an inline colour). `riskBadge`
replaced the hand-built trust-gap badges in `compiler-view.ts` and `learning.ts`
and the `stalled` marker in the release workspace; `statusChip` replaced
`activation.ts`'s `statusBadge` and its two class-name maps (they are `Tone` maps
now — the chip owns the class) and `release-workspace.ts`'s lifecycle badge.
`errorState` replaced the inline alert blocks in `data.ts` and the three in
`serve.ts` (sign-in failure, password reset, account), so nothing in the console
writes `<div class="error-summary">` by hand any more.

## 10. Next steps

- Phase 4: Ledger claim/decision readers over the existing ledger API.
- Keep the route table and this inventory in step: a new route that is not in §2
  is a documentation bug.
