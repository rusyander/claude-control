import { gitVerdict } from './git-verdict.ts';
import { isTempInside, isTempOutside, resolveFrom } from './paths.ts';
import { parse, UNPARSED, type Segment, type Word } from './shell-parse.ts';
import {
  DANGER,
  OTHER,
  ROUTINE,
  Walk,
  type GroupCommandScope,
  type SegmentVerdict,
} from './walk.ts';

export type { GroupCommandScope } from './walk.ts';
export { isProtectedBranch } from './walk.ts';

/**
 * Разбор команды оболочки группы разделения. Классификатор чата (`ruleFor`)
 * смотрит на текст регулярками и видит `--force` в `--force-with-lease`, «drop»
 * в сообщении коммита, а составную `cd <копия> && git push … 2>&1 | tail -5` не
 * узнавал вовсе.
 *
 * Политика владельца 19.10: карточка спрашивает человека ТОЛЬКО про удаление
 * (ветки локально и на удалённом, метки, копии, настоящие файлы и каталоги,
 * таблицы и базы), слияние (`git merge`, слияние MR через API или CLI форджа),
 * пуш в основную или защищённую ветку и принудительный пуш. Всё прочее
 * решается само; обычный пуш рабочей ветки — тоже.
 *
 * Здесь команда разбирается на звенья с кавычками и комментариями, и каждое
 * звено узнаётся по устройству, а не по словам:
 * - `routine` — вся команда из рутины группы (`cd` в свою копию, add, commit,
 *   fetch, rebase на origin/main, stash, пуш рабочей ветки, уборка временного,
 *   хвост вывода);
 * - `danger` — в команде есть то, что решает человек при любых строках;
 * - `other` — прочее, его решают правила чата, как раньше.
 *
 * Своя ветка приходит снаружи — прочитанной у git копии (`group-permissions.ts`),
 * и никогда не берётся из текста команды.
 */

export type GroupCommandVerdict =
  | { kind: 'routine'; writes: boolean; lease: boolean; deletes: boolean }
  | { kind: 'danger' }
  | { kind: 'other' };

/** Перенаправления, которые ничего не пишут: в поток или в никуда. */
const QUIET_REDIRECT = /^(\d*|&)>>?(&\d+|\/dev\/null|NUL)$/i;

const OUTPUT_FILTERS = new Set(['tail', 'head', 'grep', 'wc', 'sort', 'uniq', 'cat']);
const HARMLESS = new Set(['echo', 'true', 'pwd']);

const REMOVERS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'remove-item', 'shred']);

/**
 * Удаление: временное (сборка, кэш, `.agent/tmp`, `/tmp/…`) — уборка, рутина;
 * любой другой файл или каталог — человеку, в копии и вне её. Пустой каталог
 * (`rmdir` без `/s`) удалить нечего — рутина.
 */
function removeVerdict(words: Word[], walk: Walk): SegmentVerdict {
  const name = (words[0] as Word).text.toLowerCase();
  const args = words.slice(1);
  const recursive = args.some(
    (arg) =>
      /^-r(ecurse)?$/i.test(arg.text) ||
      /^-[a-zA-Z]*[rR]/.test(arg.text) ||
      arg.text === '--recursive' ||
      /^\/s$/i.test(arg.text),
  );
  if ((name === 'rmdir' || name === 'rd') && !recursive) return ROUTINE;
  const targets = args.filter((arg) => !/^-/.test(arg.text) && !/^\/[a-z]$/i.test(arg.text));
  for (const target of targets) {
    if (isTempOutside(target.text)) continue;
    if (target.dynamic || !walk.cwd) return DANGER;
    const glob = /[*?[]/.exec(target.text);
    const literal = glob ? target.text.slice(0, glob.index) : target.text;
    const placed = walk.rootOf(resolveFrom(walk.cwd, literal));
    if (!placed) return DANGER;
    // `*.log` в каталоге копии — черновики; `*` в корне — вся копия.
    const tempGlob = glob !== null && /\.(log|tmp|temp|orig|rej|bak)$/i.test(target.text);
    if (!tempGlob && !isTempInside(placed.path, placed.root)) return DANGER;
  }
  return { kind: 'routine', deletes: true };
}

/** Клиенты баз: снос в их команде — человеку. */
const DB_CLIENT =
  /^(psql|mysql|mariadb|sqlite3|sqlcmd|mongosh|mongo|redis-cli|clickhouse-client|clickhouse|pgcli|mycli|duckdb|cqlsh)(\.exe)?$/i;
const DB_DROP =
  /\b(drop\s+(table|database|schema|index|view|materialized|sequence|user|role|owned|extension|type|function|collection)|truncate\b|delete\s+from\b|flushall\b|flushdb\b|dropDatabase\b)|\.drop\s*\(/i;
/** Снос базы самостоятельной командой: `dropdb`, `prisma migrate reset`, `db:drop`. */
const DB_DESTROY =
  /(^|\s)(dropdb|dropuser)(\s|$)|\bprisma\s+migrate\s+reset\b|\bprisma\s+db\s+push\b.*--force-reset\b|\bdb:(drop|reset)\b|\bmanage\.py\s+flush\b|\bmigrate(:|\s+)(reset|fresh|rollback|down)\b/i;

function dbDanger(words: Word[]): boolean {
  const text = words.map((word) => word.text).join(' ');
  if (DB_DESTROY.test(text)) return true;
  const client = words.some((word) => DB_CLIENT.test(word.text.split(/[\\/]/).at(-1) ?? ''));
  return client && DB_DROP.test(text);
}

const FORGE_CLI = new Set(['gh', 'glab']);
const HTTP_CLI = new Set([
  'curl',
  'wget',
  'http',
  'https',
  'xh',
  'iwr',
  'irm',
  'invoke-webrequest',
  'invoke-restmethod',
]);

/**
 * Форж и HTTP: слияние MR (`gh pr merge`, `glab mr merge`, `…/merge` в адресе)
 * и удаление (`… delete`, метод DELETE) — человеку. Прочее — правила чата.
 */
function forgeVerdict(words: Word[]): SegmentVerdict {
  const name = (words[0] as Word).text.toLowerCase();
  const texts = words.map((word) => word.text);
  const method = texts.some(
    (text, i) =>
      /^(-X|--request|--method|-Method)$/i.test(texts[i - 1] ?? '') && /^delete$/i.test(text),
  );
  const toMerge = texts.some((text) => /\/merge(\b|$)/.test(text));
  if (method || toMerge) return DANGER;
  if (FORGE_CLI.has(name) && texts.slice(1, 3).some((text) => /^(merge|delete)$/.test(text))) {
    return DANGER;
  }
  return OTHER;
}

/** Обёртки, внутри которых исполняется другая команда: `bash -c "…"`, `xargs rm`. */
const WRAPPERS = new Set([
  'sudo',
  'env',
  'xargs',
  'bash',
  'sh',
  'zsh',
  'pwsh',
  'powershell',
  'cmd',
  'nohup',
  'time',
  'timeout',
  'nice',
  'wsl',
  'ssh',
  'find',
]);

/** `git … push|merge|branch -D` внутри чужой обёртки: `bash -c "git push origin main"`. */
const WRAPPED_GIT = /\bgit\b[^\n]*\b(push|merge)\b|\bgit\b[^\n]*\bbranch\b[^\n]*\s-[a-zA-Z]*[dD]\b/;
const WRAPPED_REMOVE = /(^|[\s;&|"'])(rm|rmdir|rd|del|unlink|shred|Remove-Item)\s|\s-delete\b/i;

function wrapped(words: Word[], wrapper: boolean): SegmentVerdict {
  const text = words.map((word) => word.text).join(' ');
  if (WRAPPED_GIT.test(text) || dbDanger(words)) return DANGER;
  if (wrapper && WRAPPED_REMOVE.test(text)) return DANGER;
  return OTHER;
}

function segmentVerdict(segment: Segment, walk: Walk): SegmentVerdict {
  // `ИМЯ=значение git push`: окружение может увести git в другой каталог
  // (`GIT_DIR`, `GIT_WORK_TREE`), поэтому такое звено — не рутина.
  if (/^[A-Za-z_]\w*=/.test(segment.words[0]?.text ?? '')) return wrapped(segment.words, true);
  const { words } = segment;
  const name = words[0]?.text ?? '';
  const lower = name.toLowerCase();
  const quiet = segment.redirects.every((redirect) => QUIET_REDIRECT.test(redirect));
  let verdict: SegmentVerdict;
  if (name === 'cd') {
    const dir = words[1];
    walk.cwd =
      words.length !== 2 || !dir || dir.dynamic || !walk.cwd
        ? undefined
        : resolveFrom(walk.cwd, dir.text);
    verdict = walk.inCopy(walk.cwd) ? ROUTINE : OTHER;
  } else if (name === 'git') {
    verdict = gitVerdict(words, walk);
  } else if (REMOVERS.has(lower)) {
    verdict = removeVerdict(words, walk);
  } else if (FORGE_CLI.has(lower) || HTTP_CLI.has(lower)) {
    verdict = forgeVerdict(words);
  } else if (OUTPUT_FILTERS.has(name) || HARMLESS.has(name)) {
    verdict = ROUTINE;
  } else {
    verdict = wrapped(words, WRAPPERS.has(lower));
  }
  if (verdict.kind === 'routine' && !quiet) return OTHER;
  return verdict;
}

/** Грубая проверка неразобранной команды: пуш, слияние, удаление, снос базы в ней есть? */
const RISKY_UNPARSED = [
  /(^|[;&|\n(`]\s*)git\b(\s+-\S+(\s+\S+)?)*\s+(push|merge)\b/,
  /\bgit\b[^\n]*\b(branch|tag)\b[^\n]*\s(-[a-zA-Z]*[dD]|--delete)\b/,
  /(^|[;&|\n(`]\s*)(rm|Remove-Item|rd|rmdir|del|unlink)\s/i,
  DB_DROP,
  DB_DESTROY,
  /\/merge\b|-X\s*['"]?DELETE/i,
];

export function groupCommandVerdict(
  command: string,
  scope: GroupCommandScope,
): GroupCommandVerdict {
  const segments = parse(command);
  if (segments === UNPARSED) {
    return RISKY_UNPARSED.some((pattern) => pattern.test(command))
      ? { kind: 'danger' }
      : { kind: 'other' };
  }
  const walk = new Walk(scope);
  let routine = segments.length > 0;
  let writes = false;
  let lease = false;
  let deletes = false;
  for (const segment of segments) {
    const verdict = segmentVerdict(segment, walk);
    if (verdict.kind === 'danger') return DANGER as { kind: 'danger' };
    if (verdict.kind === 'other') {
      routine = false;
      continue;
    }
    writes ||= verdict.writes === true;
    lease ||= verdict.lease === true;
    deletes ||= verdict.deletes === true;
  }
  return routine ? { kind: 'routine', writes, lease, deletes } : { kind: 'other' };
}
