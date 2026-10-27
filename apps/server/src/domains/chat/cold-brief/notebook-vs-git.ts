import { gitSync } from '../../project-git/exec/exec.ts';

/**
 * Сверка заметки группы с git на миг вводной (F-11, g0 25.10, прогон 2).
 *
 * Прогон 1 сделал rebase и push, а PROGRESS.md остался прежним: «Local, NOT pushed:
 * 471e4d863f, 8b11a770b4 + 1190bbb43f», «BLOCKED: origin/main 4a03ca18d3 конфликтует».
 * Вводная прогона 2 несла это рядом с «Your last answer», который говорил обратное, —
 * вводная спорила сама с собой. По времени файла это не узнать: «записал заметку →
 * коммит → push» — обычный порядок хода, и такая заметка не устарела. Узнаётся по
 * содержимому: коммиты, которые заметка называет, сверяются с git сейчас.
 *
 * - коммит есть, но ни одна ветка его не содержит — его переписали (rebase, amend,
 *   reset) ПОСЛЕ заметки: она описывает историю, которой нет, — вердикт «устарела»;
 * - коммит уже в ветке слежения копии — «не запушено» о нём неправда: только факт.
 * Коммит целевой ветки, ещё не взятый в копию (честное «BLOCKED»), — молчание.
 */

/** Слово, похожее на сокращённый sha: 7–40 hex с цифрой и буквой (не дата, не «defaced»). */
const SHA_TOKEN = /\b[0-9a-f]{7,40}\b/g;
/** Больше — заметка не про коммиты, а про хэши чего-то ещё; вызовов git не множим. */
export const NOTEBOOK_SHA_LIMIT = 12;
/** Глубина истории, в которой ищем по префиксу одним вызовом; глубже — по одному. */
const HISTORY_DEPTH = 2_000;

export function shaTokens(text: string): string[] {
  const found = new Set<string>();
  for (const [token] of text.matchAll(SHA_TOKEN)) {
    if (!/\d/.test(token) || !/[a-f]/.test(token)) continue;
    found.add(token);
    if (found.size >= NOTEBOOK_SHA_LIMIT) break;
  }
  return [...found];
}

function history(cwd: string, ref: string): string[] {
  return (gitSync(cwd, ['rev-list', '-n', String(HISTORY_DEPTH), ref]) ?? '')
    .split('\n')
    .filter(Boolean);
}

/** Ветка слежения копии; не настроена — `origin/<ветка>`, если такая есть. */
function upstreamOf(cwd: string, branch: string | undefined): string | undefined {
  const named = gitSync(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])?.trim();
  if (named) return named;
  if (!branch || branch === 'HEAD') return undefined;
  const remote = `refs/remotes/origin/${branch}`;
  return gitSync(cwd, ['rev-parse', '--verify', '--quiet', remote]) !== undefined
    ? `origin/${branch}`
    : undefined;
}

/** Коммит есть в базе объектов, но ни одна ссылка его не содержит — переписан. */
function rewritten(cwd: string, token: string): boolean {
  if (gitSync(cwd, ['rev-parse', '--verify', '--quiet', `${token}^{commit}`]) === undefined) {
    return false;
  }
  const holders = gitSync(cwd, ['for-each-ref', '--count=1', '--contains', token]);
  return holders !== undefined && !holders.trim();
}

/**
 * Строка под разделом заметки — что из названных ею коммитов git сейчас видит
 * иначе; пусто — расхождений нет (или коммитов заметка не называет).
 */
export function notebookVsGit(cwd: string, text: string, branch: string | undefined): string {
  const tokens = shaTokens(text);
  if (tokens.length === 0) return '';
  const onHead = history(cwd, 'HEAD');
  if (onHead.length === 0) return '';
  const upstream = upstreamOf(cwd, branch);
  const onUpstream = upstream ? history(cwd, upstream) : [];
  const has = (list: string[], token: string) => list.some((sha) => sha.startsWith(token));
  const gone: string[] = [];
  const pushed: string[] = [];
  for (const token of tokens) {
    if (has(onUpstream, token)) pushed.push(token);
    else if (!has(onHead, token) && rewritten(cwd, token)) gone.push(token);
  }
  const found: string[] = [];
  if (gone.length) {
    found.push(
      `no longer on any branch (rewritten by a rebase/amend/reset after this was written): ${gone.join(', ')}`,
    );
  }
  if (pushed.length) found.push(`already on ${upstream}: ${pushed.join(', ')}`);
  if (found.length === 0) return '';
  const line = `(Checked against git now — ${found.join('; ')}.)`;
  return gone.length
    ? `${line} This notebook is STALE: where it disagrees with the commits and «Your last answer» ` +
        'below, they win — refresh it before acting on its state.'
    : line;
}
