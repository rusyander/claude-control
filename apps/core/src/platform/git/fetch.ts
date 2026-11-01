import type { Fact } from '@agentdeck/contracts/core/facts';
import { readFact } from '../../lib/facts/read-fact.ts';
import { commitOf, defaultBaseOf } from '../copy-git.ts';
import type { GitOptions } from './git.types.ts';
import { git } from './run.ts';

/**
 * База задачи при оценке (G5, G20, F-169): свежая удалённая ветка, приколотая sha один раз —
 * единицы растут от неё, а не от того, что лежит в основной копии сейчас. `git fetch` удалённого
 * (класс `git.fetch-base`): не ответил — приколота ЛОКАЛЬНАЯ ссылка и это названо (`note`), не
 * молчаливое «свежо». Пароль не спрашивается никогда (`GIT_TERMINAL_PROMPT=0` у `git()`,
 * `GCM_INTERACTIVE=never` здесь): окно входа поверх экрана оценки — не ответ.
 */

export interface BasePin {
  /** Ссылка, от которой взята база (`origin/main`, `main`, названная человеком). */
  ref: string;
  sha: string;
  /** `fresh` — удалённый подтянут сейчас; `local` — fetch не прошёл или удалённого нет. */
  source: 'fresh' | 'local';
  note: string | null;
}

const FETCH_ENV = { GCM_INTERACTIVE: 'never' };
const REASON_MAX = 300;

/** Причина для экрана оценки: строка git `fatal:`, а не вся команда с выводом дважды. */
function shortReason(reason: string): string {
  const fatal = reason.split('\n').find((l) => l.trim().startsWith('fatal:'));
  return (fatal ?? reason).trim().slice(0, REASON_MAX);
}

/** Имена удалённых; предпроверка `ls-remote` идёт по каждому из них. */
export async function remotesOf(repo: string, options: GitOptions): Promise<string[]> {
  const out = await git(repo, ['remote'], { ...options, timeoutMs: 30_000 });
  return out.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

/** Удалённый, которого касается ссылка: `origin/x` → `origin`; иначе `origin` или первый. */
function remoteFor(ref: string | null, remotes: readonly string[]): string | null {
  if (ref !== null) {
    const named = remotes.find((r) => ref.startsWith(`${r}/`));
    if (named) return named;
  }
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
}

export function fetchRemote(
  repo: string,
  remote: string,
  options: GitOptions = {},
): Promise<Fact<true>> {
  return readFact('git.fetch-base', async () => {
    await git(repo, ['fetch', '--quiet', '--no-tags', '--prune', remote], {
      ...options,
      timeoutMs: 60_000,
      extraEnv: FETCH_ENV,
    });
    return true as const;
  });
}

/**
 * Приколоть базу: `baseRef` человека или основная ветка (`defaultBaseOf`), после fetch её
 * удалённого. Ссылки нет — `absent` (задача без базы не создаётся); git не ответил — `unknown`.
 */
export async function pinBase(
  repo: string,
  baseRef: string | null,
  options: GitOptions & { fetch?: typeof fetchRemote } = {},
): Promise<Fact<BasePin>> {
  let remotes: string[];
  try {
    remotes = await remotesOf(repo, options);
  } catch (error) {
    return { unknown: `git remote: ${error instanceof Error ? error.message : String(error)}` };
  }
  const remote = remoteFor(baseRef, remotes);
  let source: BasePin['source'] = 'local';
  let note: string | null = remote === null ? 'no remote: local ref pinned' : null;
  if (remote !== null) {
    const fetched = await (options.fetch ?? fetchRemote)(repo, remote, options);
    if ('value' in fetched) source = 'fresh';
    else
      note = `fetch ${remote} failed (${shortReason('unknown' in fetched ? fetched.unknown : 'absent')}): local ref pinned`;
  }
  let ref = baseRef;
  if (ref === null) {
    const found = await defaultBaseOf(repo, options);
    if (!('value' in found)) return found;
    ref = found.value;
  }
  const sha = await commitOf(repo, ref, options);
  if (!('value' in sha)) return sha;
  // Ссылка локальная (не `<remote>/…`) — свежесть fetch её не касается: так и сказано.
  if (source === 'fresh' && remote !== null && !ref.startsWith(`${remote}/`)) {
    source = 'local';
    note = `${ref} is a local branch: pinned as is, the fetch of ${remote} does not move it`;
  }
  return { value: { ref, sha: sha.value, source, note } };
}
