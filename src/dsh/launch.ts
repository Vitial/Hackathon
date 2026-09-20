import { createRequire } from 'node:module';
import type { DshClientOptions } from './client.ts';

/**
 * Build DshClientOptions from the environment. Returns undefined unless
 * DSH_ENABLED=1 — dsh stays opt-in until the adapter is proven, so the
 * default worker path (jcode socket, else local-echo) is unchanged.
 *
 *   DSH_ENABLED=1            select the dsh adapter
 *   DSH_BIN                  dsh CLI entry (default: installed @deepseek-ai/dsh bin)
 *   DSH_COMMAND              runtime executable (default: current node)
 *   DSH_PROFILE              dsh profile (default: sdk)
 *   DSH_PATCHES              comma-separated extra --patch overlays (e.g. our
 *                            approval-answerer plugin patch)
 *   DSH_ARGS                 full launch-args override (advanced / tests):
 *                            replaces `[bin --patch ... --profile ...]`
 *                            wholesale, space-separated. The runner still
 *                            appends its per-run `--patch`.
 *   DSH_PROVIDER             provider route (default: deepseek-official)
 *   DSH_MODEL                model name (default: deepseek-v4-flash)
 *   DSH_MAX_TOKENS           per-request output cap (default: unset)
 *   DSH_CWD                  workspace cwd recorded on sessions
 */
export function dshClientOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): DshClientOptions | undefined {
  if (env.DSH_ENABLED !== '1') return undefined;
  const binPath = env.DSH_BIN ?? createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js');
  const profile = env.DSH_PROFILE ?? 'sdk';
  const patches = (env.DSH_PATCHES ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const args: string[] =
    env.DSH_ARGS !== undefined && env.DSH_ARGS.trim().length > 0
      ? env.DSH_ARGS.split(' ').filter((a) => a.length > 0)
      : (() => {
          const a: string[] = [];
          for (const p of patches) a.push('--patch', p);
          a.push('--profile', profile);
          return a;
        })();
  const maxTokens = env.DSH_MAX_TOKENS ? Number(env.DSH_MAX_TOKENS) : undefined;
  const fullOverride = env.DSH_ARGS !== undefined && env.DSH_ARGS.trim().length > 0;
  return {
    launch: {
      command: env.DSH_COMMAND ?? process.execPath,
      // Full override replaces [bin, ...flags] wholesale (the fake runtime
      // is its own executable: node <fixture>, no dsh bin involved).
      args: fullOverride ? args : [binPath, ...args],
    },
    cwd: env.DSH_CWD,
    provider: env.DSH_PROVIDER,
    model: env.DSH_MODEL,
    maxTokens: maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : undefined,
  };
}
