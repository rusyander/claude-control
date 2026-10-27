import type { ReviewCommit, ReviewDelta } from '@agentdeck/contracts/model-cascade';
import { gitSync } from './exec/exec.ts';

/**
 * Что работа изменила против ОПУБЛИКОВАННОГО состояния своей ветки (L7.13).
 *
 * Журнал 19.10 02:19: группа, чей MR уже стоял на ревью, в новой сессии только
 * перенесла ветку на свежую основную и запушила её арендой. `hasWorkSince` видит
 * «работу» — rebase переписывает даты коммитов, — и панель завела ревью всего
 * MR: 49 файлов, гейты и mustfail на тех же патчах. Ответ здесь — `git
 * range-diff` серии коммитов на начало сессии против серии сейчас, каждая над
 * своей базой на основной: у пустого rebase каждая строка `=`.
 *
 * «Опубликовано» берётся из журналов ссылок, без сети и без записей панели:
 * значение ветки и её удалённого двойника НА МОМЕНТ `since` (начало звена).
 * Совпали — работа началась с того, что уже лежало на удалённом. Любое «не
 * знаю» (журнала на тот момент нет, копия грязная, нет `origin/HEAD`, git не
 * ответил) — `whole`: ревью всей работы, как раньше. Пропустить ревью по
 * ошибке дороже, чем прочитать лишнее.
 */
export function readReviewDelta(
  cwd: string,
  since: string | undefined,
  /**
   * Коммит начала группы (`ChatLink.startSha`, владелец 26.10). Известен — охват ревью
   * считается от него, а не по журналу ссылок: начало группы записано, угадывать незачем.
   * Неизвестный git коммит — прежний путь.
   */
  startSha?: string,
): ReviewDelta {
  const group = startSha ? readGroupDelta(cwd, startSha) : undefined;
  if (group) return group;
  const whole: ReviewDelta = { kind: 'whole' };
  const sinceMs = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(sinceMs)) return whole;

  // Незакоммиченное — тоже работа, а range-diff его не видит.
  const status = gitSync(cwd, ['--no-optional-locks', 'status', '--porcelain']);
  if (status === undefined || status.trim()) return whole;

  const branch = gitSync(cwd, ['symbolic-ref', '--quiet', 'HEAD'])?.trim();
  const upstream = gitSync(cwd, [
    'rev-parse',
    '--symbolic-full-name',
    '--verify',
    '--quiet',
    '@{upstream}',
  ])?.trim();
  if (!branch || !upstream?.startsWith('refs/remotes/')) return whole;

  const start = refAt(cwd, branch, sinceMs);
  if (!start || refAt(cwd, upstream, sinceMs) !== start) return whole;

  const remote = upstream.slice('refs/remotes/'.length).split('/')[0];
  const main = gitSync(cwd, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`])?.trim();
  const head = gitSync(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim();
  if (!main || !head) return whole;
  const oldBase = gitSync(cwd, ['merge-base', main, start])?.trim();
  const newBase = gitSync(cwd, ['merge-base', main, head])?.trim();
  if (!oldBase || !newBase) return whole;

  const ranges = [`${short(oldBase)}..${short(start)}`, `${short(newBase)}..HEAD`];
  const out = gitSync(cwd, ['range-diff', '--no-color', ...ranges], 20_000);
  if (out === undefined) return whole;
  const pairs = parseRangeDiff(out);
  // Вывод есть, а разобрать его нечем — формат не тот, что ожидали: не гадаем.
  if (pairs === undefined) return whole;

  const changes = pairs.filter((pair) => pair.mark !== '=').map((pair) => pair.line);
  if (changes.length === 0) {
    const pushed = gitSync(cwd, ['rev-parse', '--verify', '--quiet', upstream])?.trim();
    return { kind: 'none', from: short(start), published: pushed === head };
  }
  return {
    kind: 'delta',
    from: short(start),
    command: `git range-diff ${ranges.join(' ')}`,
    changes: changes.slice(0, CHANGES_MAX),
  };
}

/**
 * Охват ревью по коммиту начала группы (владелец 26.10, замечание 4): задача «только
 * конфликт» — один коммит слияния, новая работа на готовом MR — только новые коммиты.
 *
 * - начало — предок головы: цепочка первых родителей `start..HEAD`; у слияния своё у
 *   группы — только разрешение конфликтов (`git show --remerge-diff` непуст). Ни коммита,
 *   ни своего в слияниях, копия чистая — `none`: ревью читать нечего;
 * - не предок (rebase после начала): `git range-diff` серии начала против серии головы,
 *   каждая над своей базой на основной — как у опубликованной ветки (L7.13);
 * - `undefined` — начало git не знает или ответа нет: прежний путь.
 */
function readGroupDelta(cwd: string, startSha: string): ReviewDelta | undefined {
  if (!/^[0-9a-f]{7,64}$/.test(startSha)) return undefined;
  const start = gitSync(cwd, ['rev-parse', '--verify', '--quiet', `${startSha}^{commit}`])?.trim();
  const head = gitSync(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim();
  const status = gitSync(cwd, ['--no-optional-locks', 'status', '--porcelain']);
  if (!start || !head || status === undefined) return undefined;
  const dirty = Boolean(status.trim());
  const from = short(start);

  if (gitSync(cwd, ['merge-base', '--is-ancestor', start, head]) === undefined) {
    return rebasedDelta(cwd, { start, head, from, dirty });
  }
  const log = gitSync(
    cwd,
    ['log', '--first-parent', '--format=%H%x09%P%x09%s', `${start}..${head}`],
    20_000,
  );
  if (log === undefined) return undefined;
  const entries = log
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([sha]) => sha && /^[0-9a-f]{7,64}$/.test(sha));
  const commits: ReviewCommit[] = entries
    .slice(0, CHANGES_MAX)
    .map(([sha = '', parents = '', subject = '']) => ({
      sha: short(sha),
      subject: subject.trim(),
      type: parents.trim().split(/\s+/).length > 1 ? mergeType(cwd, sha) : 'commit',
    }));
  const more = entries.length - commits.length;
  const nothing = more === 0 && commits.every((commit) => commit.type === 'clean-merge');
  if (nothing && !dirty)
    return { kind: 'none', from, published: published(cwd, head), group: true };
  return { kind: 'commits', from, commits, ...(more > 0 ? { more } : {}), dirty };
}

/**
 * Своё у группы в коммите слияния — только разрешение конфликтов: `--remerge-diff`
 * показывает разницу между автоматическим слиянием и записанным. Пусто — слияние чистое.
 * Не ответил (git старше 2.36, вывод больше буфера) — читаем: пропустить дороже.
 */
function mergeType(cwd: string, sha: string): ReviewCommit['type'] {
  const out = gitSync(
    cwd,
    ['show', '--remerge-diff', '--format=', '--no-color', '--name-only', sha],
    20_000,
  );
  return out !== undefined && !out.trim() ? 'clean-merge' : 'merge';
}

/** Голова уже на удалённом двойнике ветки — доставлять нечего. */
function published(cwd: string, head: string): boolean {
  return gitSync(cwd, ['rev-parse', '--verify', '--quiet', '@{upstream}'])?.trim() === head;
}

/** Начало группы — не предок головы: ветку перенесли после него. Серии над своими базами. */
function rebasedDelta(
  cwd: string,
  at: { start: string; head: string; from: string; dirty: boolean },
): ReviewDelta | undefined {
  const upstream = gitSync(cwd, [
    'rev-parse',
    '--symbolic-full-name',
    '--verify',
    '--quiet',
    '@{upstream}',
  ])?.trim();
  const remote = upstream?.startsWith('refs/remotes/')
    ? upstream.slice('refs/remotes/'.length).split('/')[0]
    : 'origin';
  const main = gitSync(cwd, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`])?.trim();
  if (!main) return undefined;
  const oldBase = gitSync(cwd, ['merge-base', main, at.start])?.trim();
  const newBase = gitSync(cwd, ['merge-base', main, at.head])?.trim();
  if (!oldBase || !newBase) return undefined;
  const ranges = [`${short(oldBase)}..${at.from}`, `${short(newBase)}..HEAD`];
  const out = gitSync(cwd, ['range-diff', '--no-color', ...ranges], 20_000);
  const pairs = out === undefined ? undefined : parseRangeDiff(out);
  if (!pairs) return undefined;
  const changes = pairs.filter((pair) => pair.mark !== '=').map((pair) => pair.line);
  if (changes.length === 0 && !at.dirty) {
    return { kind: 'none', from: at.from, published: published(cwd, at.head), group: true };
  }
  return {
    kind: 'delta',
    from: at.from,
    command: `git range-diff ${ranges.join(' ')}`,
    changes: changes.slice(0, CHANGES_MAX),
    group: true,
    ...(at.dirty ? { dirty: true } : {}),
  };
}

/** Сколько строк range-diff едет в задание ревью — команда покажет и остальные. */
const CHANGES_MAX = 30;

function short(sha: string): string {
  return sha.slice(0, 12);
}

/**
 * Значение ссылки на момент `atMs` по её журналу: последняя запись не позже.
 * `rev-parse ref@{date}` для этого не годится — когда журнал моложе даты, git
 * молча отдаёт самую старую запись, и ветка, запушенная через час после начала
 * звена, выглядела бы опубликованной до него.
 */
function refAt(cwd: string, ref: string, atMs: number): string | undefined {
  const log = gitSync(cwd, ['reflog', 'show', '--date=unix', '--format=%H %gd', ref, '--']);
  if (!log) return undefined;
  for (const line of log.split('\n')) {
    const match = /^([0-9a-f]{7,64}) .*@\{(\d+)\}$/.exec(line.trim());
    if (match && Number(match[2]) * 1000 <= atMs) return match[1];
  }
  return undefined;
}

interface RangePair {
  mark: '=' | '!' | '<' | '>';
  line: string;
}

/**
 * Строки пар `git range-diff`: `1:  abc1234 = 1:  def5678 тема`. Тело diff'а
 * у `!` идёт с отступом и сюда не попадает. `undefined` — вывод непустой, а ни
 * одной пары в нём нет.
 */
export function parseRangeDiff(out: string): RangePair[] | undefined {
  const pairs: RangePair[] = [];
  for (const raw of out.split('\n')) {
    const match =
      /^\s*(?:\d+|-):\s+(?:[0-9a-f]+|-+)\s+([=!<>])\s+(?:\d+|-):\s+(?:[0-9a-f]+|-+)/.exec(raw);
    if (match) pairs.push({ mark: match[1] as RangePair['mark'], line: raw.trim() });
  }
  return pairs.length === 0 && out.trim() ? undefined : pairs;
}
