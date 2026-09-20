// Upstream drift report (docs/upstream.md): compares cloned SHAs against
// live remote HEADs. Informational — exit 0 always. A human decides whether
// drift is worth a rebase; CI must never fail just because upstream moved.
// Buzz carries ~1.5k open issues / ~2k PRs: it moves fast, so we pin and
// rebase on cadence or on need, never floating.
import { execFileSync } from 'node:child_process';

for (const r of ['qm', 'buzz', 'jcode-1jehuang', 'tdam']) {
  const dir = `.upstream/${r}`;
  let local = '';
  try {
    local = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  } catch {
    console.log(`${r}: not cloned`);
    continue;
  }
  let live = '';
  try {
    live =
      execFileSync('git', ['ls-remote', 'origin', 'HEAD'], { cwd: dir, timeout: 30000 }).toString().split(/\s/)[0] ??
      '';
  } catch {
    console.log(`${r}: local ${local.slice(0, 12)} live unreachable → UNKNOWN`);
    continue;
  }
  console.log(
    `${r}: local ${local.slice(0, 12)} live ${live.slice(0, 12)} → ${local === live ? 'IN SYNC' : 'DRIFTED'}`,
  );
}

// deepseek-harness: vendored in-tree at vendor/deepseek-harness/, not
// a .upstream/ clone. Compare the pinned SHA from docs/upstream.md
// against the live remote HEAD.
const VENDORED_PIN = 'ddefc45fbc7f8e46dd73185e68295696d1297887';
try {
  const live =
    execFileSync('git', ['ls-remote', 'https://github.com/deepseek-ai/deepseek-harness.git', 'HEAD'], {
      timeout: 30000,
    })
      .toString()
      .split(/\s/)[0] ?? '';
  console.log(
    `deepseek-harness (vendor): pinned ${VENDORED_PIN.slice(0, 12)} live ${live.slice(0, 12)} → ${VENDORED_PIN === live ? 'IN SYNC' : 'DRIFTED'}`,
  );
} catch {
  console.log(`deepseek-harness (vendor): pinned ${VENDORED_PIN.slice(0, 12)} live unreachable → UNKNOWN`);
}
