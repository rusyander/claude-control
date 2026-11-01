import type { GitOptions } from './git.types.ts';
import { git } from './run.ts';

/**
 * Пуш ветки единицы публикатором (05 §Push and MR) — единственный пуш ядра, и только через
 * outbox. До MR ветку можно переписать, но ровно с ожидаемым sha сервера
 * (`--force-with-lease=refs/heads/<b>:<sha>`, пустой sha — «ветки не должно быть»); после MR —
 * никогда силой: правки идут новыми коммитами, не перемотка — отказ сервера, не перезапись.
 */

/** Как пушить — структурно `PublisherPushSpec` стража (G): адрес, ключи git, окружение. */
export interface PushRoute {
  url: string;
  gitArgs: readonly string[];
  env: Readonly<Record<string, string>>;
  dropEnv: readonly string[];
}

export type PushMode =
  /** До MR: перезапись с точным ожиданием; `null` — ветки на сервере быть не должно. */
  | { kind: 'lease'; expect: string | null }
  /** После MR: только перемотка вперёд. */
  | { kind: 'fast-forward' };

export type PushResult = { kind: 'pushed' } | { kind: 'rejected'; detail: string };

export function pushArgs(route: PushRoute, branch: string, sha: string, mode: PushMode): string[] {
  const ref = `refs/heads/${branch}`;
  const lease = mode.kind === 'lease' ? [`--force-with-lease=${ref}:${mode.expect ?? ''}`] : [];
  return [...route.gitArgs, 'push', '--porcelain', ...lease, '--', route.url, `${sha}:${ref}`];
}

function baseEnv(drop: readonly string[], env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = new Set(drop.map((d) => d.toUpperCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!names.has(k.toUpperCase())) out[k] = v;
  return out;
}

/** `--porcelain`: строка `!` — ссылку сервер отверг (не перемотка, аренда не сошлась). */
export function parsePush(code: number | null, stdout: string): PushResult {
  const rejected = stdout.split('\n').find((l) => l.startsWith('!'));
  if (rejected) return { kind: 'rejected', detail: rejected.slice(1).trim() };
  if (code !== 0) throw new Error(`push exit ${String(code)}: ${stdout.trim().slice(0, 300)}`);
  return { kind: 'pushed' };
}

export async function pushBranch(
  repo: string,
  route: PushRoute,
  branch: string,
  sha: string,
  mode: PushMode,
  options: GitOptions = {},
): Promise<PushResult> {
  const out = await git(repo, pushArgs(route, branch, sha, mode), {
    ...options,
    env: baseEnv(route.dropEnv, options.env ?? process.env),
    extraEnv: { ...route.env },
    timeoutMs: 120_000,
    acceptNonZero: true,
  });
  return parsePush(out.code, out.stdout);
}

/** Удаление ссылки сервера (`clean-remote`, P102): ровно названная, с арендой по её sha. */
export async function deleteRemoteRef(
  repo: string,
  route: PushRoute,
  ref: string,
  expect: string | null,
  options: GitOptions = {},
): Promise<PushResult> {
  const lease = expect ? [`--force-with-lease=${ref}:${expect}`] : [];
  const out = await git(
    repo,
    [...route.gitArgs, 'push', '--porcelain', ...lease, '--', route.url, `:${ref}`],
    {
      ...options,
      env: baseEnv(route.dropEnv, options.env ?? process.env),
      extraEnv: { ...route.env },
      timeoutMs: 120_000,
      acceptNonZero: true,
    },
  );
  return parsePush(out.code, out.stdout);
}
