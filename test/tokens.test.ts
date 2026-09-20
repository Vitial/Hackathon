import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { T, eq } from './helpers.ts';

console.log('\n\x1b[1mDesign tokens — one palette, one guard\x1b[0m');

/**
 * Colour literals belong in the token sheet (`theme.ts`) and nowhere else. Every
 * surface that keeps a private palette becomes a place a theme change is missed,
 * a dark-mode fix is forgotten, or a contrast check cannot reach.
 *
 * This is a ratchet, not a purge: the files below still carry their own colours,
 * and each is here for a stated reason. The assertion runs both ways, so the
 * list can only shrink by fixing a file, never by adding one.
 */
const TOKEN_SHEET = 'src/console/theme.ts';

const PENDING: Record<string, string> = {
  // The only remaining exemptions, and they are a product decision rather than
  // debt: the Buzz chat must read as Buzz/Slack, so its palette is its own and
  // must NOT be repainted by a console token change.
  'src/console/buzz.ts': 'chat surface, theme-isolated on purpose',
  'src/console/workspace-shell.ts': 'chat shell, theme-isolated on purpose',
};

// `(?<!&)` is load-bearing: `&#039;` is an HTML entity, and matching the `#039`
// inside it made this guard report a colour that does not exist — which is how a
// ratchet starts getting "temporary" entries added to it.
const HEX = /(?<!&)#[0-9A-Fa-f]{6}\b|(?<!&)#[0-9A-Fa-f]{3}\b/g;

function filesWithHex(dir: string): { file: string; count: number }[] {
  const out: { file: string; count: number }[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.ts')) continue;
    const file = `${dir}${dir.endsWith('/') ? '' : '/'}${entry}`.split('\\').join('/');
    if (file === TOKEN_SHEET) continue; // the sheet is where literals live
    const src = readFileSync(join(dir, entry), 'utf8');
    const count = (src.match(HEX) ?? []).length;
    if (count > 0) out.push({ file, count });
  }
  return out;
}

T('no new surface invents its own palette (ratchet)', () => {
  const console_ = filesWithHex('src/console');
  const talk = filesWithHex('src/talk');
  const offending = [...console_, ...talk];
  console.log(`    files carrying raw colour literals: ${offending.length}`);
  for (const f of offending) console.log(`      ${f.file}  (${f.count})`);

  const unexpected = offending.filter((f) => !(f.file in PENDING)).map((f) => f.file);
  eq(
    unexpected,
    [],
    'these files carry their own colours but are not on the pending list — add tokens instead of a palette:',
  );
});

T('the pending list cannot lie: a migrated file must be removed from it', () => {
  // Two-way enforcement is what makes this a burn-down rather than a graveyard.
  // If a file no longer has raw colours, leaving it listed would silently
  // re-permit a palette the next time someone edits it.
  const stillDirty = new Set(filesWithHex('src/console').map((f) => f.file));
  const stale = Object.keys(PENDING).filter((f) => f.startsWith('src/console/') && !stillDirty.has(f));
  eq(stale, [], 'these are clean now — delete them from PENDING:');
});

T('the meeting room reads the stage tokens, and the console supplies them', () => {
  // The room is dark in both themes, so its colours are a named group in
  // theme.ts rather than a local palette. Two halves matter: the surface must not
  // carry literals, and the served document must actually receive the token
  // block — a `var()` that resolves to nothing renders as transparent, which no
  // type check would catch.
  //
  // The room is a cluster, not one file: the page composes its CSS and markup
  // from `meeting-room-css` and `meeting-icons`, so measuring only `meetings.ts`
  // would report a palette that had merely moved as one that had been dropped.
  const ROOM_FILES = ['src/console/meetings.ts', 'src/console/meeting-room-css.ts', 'src/console/meeting-icons.ts'];
  const sources = ROOM_FILES.map((file) => ({ file, src: readFileSync(file, 'utf8') }));
  const withLiterals = sources.filter(({ src }) => (src.match(HEX) ?? []).length > 0).map(({ file }) => file);
  eq(withLiterals, [], 'the meeting room has no colour literals:');
  eq(
    sources.some(({ src }) => src.includes('var(--v-stage-')),
    true,
    'the meeting room reads stage tokens:',
  );
  // The colours it uses must all be declared, or the page silently loses them.
  // Union across the cluster, for the same reason the files above are a set.
  const used = [
    ...new Set(
      sources.flatMap(({ src }) => (src.match(/var\((--v-stage-[a-z0-9-]+)\)/g) ?? []).map((v) => v.slice(4, -1))),
    ),
  ];
  const sheet = readFileSync(TOKEN_SHEET, 'utf8');
  const undeclared = used.filter((token) => !sheet.includes(`${token}:`));
  eq(undeclared, [], 'every stage token the room uses is declared:');
  eq(used.length > 40, true, 'the stage palette is actually in use:');
});

T("a tone is the shared map's to decide, and a chip is the chip to build", () => {
  // `TONE_CLASS` is the only place a tone becomes a `.v-badge-*` class. A surface
  // that writes one out — or builds one by concatenation — has decided a state's
  // colour for itself, and that is how the same review status reads amber on one
  // page and blue on the page it links to. The chip owns its markup; the map owns
  // its colour; nobody else gets an opinion.
  const OWNERS = ['src/console/theme.ts', 'src/console/components.ts'];
  const LITERAL = /v-badge-(?:good|warn|risk|info)\b/;
  // A class built at runtime is the same decision written the long way round.
  const BUILT = /v-badge-\$\{|v-badge-'\s*\+|v-badge-"\s*\+/;
  // And the element itself: the chip owns its markup, including its size, so a
  // surface that wants a tighter one asks for `size: 'sm'` rather than writing
  // the span out and losing the next thing the chip gains.
  const HAND_BUILT = /class="v-badge"/;

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`);
      else if (entry.name.endsWith('.ts')) files.push(`${dir}/${entry.name}`);
    }
  };
  walk('src/console');

  const scanning = files.filter((f) => !OWNERS.includes(f));
  eq(scanning.length > 20, true, 'the scan actually reached the surfaces:');
  const offenders = scanning.flatMap((f) => {
    const src = readFileSync(f, 'utf8');
    const hits: string[] = [];
    src.split('\n').forEach((line, i) => {
      if (LITERAL.test(line) || BUILT.test(line) || HAND_BUILT.test(line)) hits.push(`${f}:${i + 1}`);
    });
    return hits;
  });
  eq(offenders, [], 'chips come from statusChip/riskBadge, not from the surface:');

  // Both sizes and both shapes are the chip's, and a size the sheet does not
  // define would render at the default without anyone noticing.
  const ownerSrc = readFileSync('src/console/components.ts', 'utf8');
  eq(ownerSrc.includes("size === 'sm' ? ' v-badge-sm'"), true, 'the size becomes a class:');
  eq(readFileSync('src/console/theme.ts', 'utf8').includes('.v-badge-sm{'), true, 'and the sheet defines it:');

  // And the other direction: the owner must still be the one that names them, or
  // this guard would pass on a console that had simply deleted every chip.
  const owner = readFileSync('src/console/components.ts', 'utf8');
  eq(owner.includes("good: 'v-badge-good'"), true, 'TONE_CLASS still names the classes:');
});

T('the review surface reads the token sheet, not a private palette', () => {
  // code-review.ts was the worst offender (its own --ink/--teal plus raw hex).
  // It is the worked example for the rest of the migration, so pin it.
  const src = readFileSync('src/console/code-review.ts', 'utf8');
  const cssBlock = /const CSS = `([\s\S]*?)`;/.exec(src)?.[1] ?? '';
  eq(cssBlock.length > 0, true, 'CSS block found:');
  eq((cssBlock.match(HEX) ?? []).length, 0, 'review CSS has no colour literals:');
  eq(cssBlock.includes('var(--v-ink)'), true, 'review CSS reads theme tokens:');
  eq(cssBlock.includes('var(--font-body)'), true, 'review CSS reads the token font stack:');
});
