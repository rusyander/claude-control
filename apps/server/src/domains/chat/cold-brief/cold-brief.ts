import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitSync } from '../../project-git/exec/exec.ts';
import { readTailRecords } from '../ChatTranscriptFile/ChatTranscriptFile.ts';
import { textOf } from '../ChatRecords/ChatRecords.ts';
import { lastAskedInputIn } from '../pending-asks/pending-asks.ts';
import { TASK_NOTEBOOK } from '../task-notebook/task-notebook.ts';
import { TASK_TICKETS } from '../task-tickets/task-tickets.ts';
import { REVIEW_FINDINGS } from '../review-findings/review-findings.ts';
import { notebookVsGit } from './notebook-vs-git.ts';

/**
 * Факты для нового разговора вместо остывшего (рычаг `freshOnColdResume`).
 *
 * Собирает их ПАНЕЛЬ — из файлов копии и хвоста прежнего транскрипта. Просить
 * остывшую сессию пересказать себя нельзя: пересказ — это холодное чтение всего
 * окна плюс его переписывание, ровно та цена, которой избегаем. Просить новую
 * сессию собрать факты самой — десяток мелких вызовов на `git status`, `git log`
 * и заметки, каждый со всей базой в окне; собранные здесь, они стоят один раз.
 */

/** Сколько заметок группы едет в вводную: дальше — путь, модель дочитает сама. */
export const BRIEF_NOTEBOOK_CHARS = 4_000;
/**
 * Заметки до этого размера едут целиком: обрезанный на 4k PROGRESS.md в 6,4k
 * новая сессия первым же вызовом перечитывала ЦЕЛИКОМ (группа 1, 25.10) — 4k
 * дважды. Длиннее — обрез по строке с номером строки, с которой читать остаток.
 */
export const BRIEF_NOTEBOOK_WHOLE = 8_000;
/** Последний ответ прежнего разговора — итог стадии, а не весь её ход. */
export const BRIEF_LAST_ANSWER_CHARS = 3_000;
export const BRIEF_GIT_LINES = 40;
/** Файлов ветки во вводной, когда всё закоммичено (`changedFacts`). */
export const BRIEF_CLEAN_DIFF_LINES = 10;

/**
 * Заметки группы в её копии — в порядке, в котором их стоит читать. Первыми —
 * блокнот и тикеты, которые панель велит группе вести (`GROUP_ECONOMY_PROMPT`):
 * там решения стадий; без них новая сессия собирает их заново.
 */
const NOTEBOOK_FILES = [
  TASK_NOTEBOOK,
  TASK_TICKETS,
  REVIEW_FINDINGS,
  '.agent/PROGRESS.md',
  '.agent/notes.md',
];
/** Заметки о состоянии ветки (что закоммичено, что запушено) — их сверяем с git. */
const STATE_NOTEBOOKS = new Set([TASK_NOTEBOOK, '.agent/PROGRESS.md']);
/**
 * Справочные заметки — копия трекера и ловушки проекта: в вводную идёт оглавление.
 * g8 26.10 (F12): тело GOR-1063 с комментариями (3,8 тыс.) и разделы канона и входа
 * на стенд (1,7 тыс.) ехали в каждом ходе сессии, которой оставалось снять MR с
 * черновика. Файл в копии — новая сессия прочтёт нужный раздел сама.
 * Находки ревью (R7, 27.10) — тоже справка: в вводную идут их номера и заголовки.
 */
const REFERENCE_NOTEBOOKS = new Set([TASK_TICKETS, REVIEW_FINDINGS, '.agent/notes.md']);
/** Справочная заметка до этого размера едет целиком — оглавление не дешевле. */
export const BRIEF_REFERENCE_WHOLE = 1_500;

/** Ветки, от которых считаются изменения группы: первая найденная — база. */
const BASE_REFS = ['origin/HEAD', 'origin/main', 'origin/master'];

/**
 * Обрез с указанием, где остаток. Без него «не собирай заново» в шапке читается
 * как запрет дочитать: хвост PROGRESS.md с планом и «не трогать» терялся молча.
 */
function clip(text: string, max: number, rest: string): string {
  const trimmed = text.trim();
  return trimmed.length > max
    ? `${trimmed.slice(0, max)}\n…(cut at ${max} chars — ${rest})`
    : trimmed;
}

/**
 * Заметка группы: целиком до `BRIEF_NOTEBOOK_WHOLE`, иначе — по границе строки до
 * `BRIEF_NOTEBOOK_CHARS` и номер строки, с которой начинается остаток: «дочитай»
 * без него читался как «прочти файл заново», и первые 4k шли в окно дважды.
 */
function clipNotebook(text: string, rel: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= BRIEF_NOTEBOOK_WHOLE) return trimmed;
  const cut = trimmed.lastIndexOf('\n', BRIEF_NOTEBOOK_CHARS);
  if (cut <= 0) {
    return clip(trimmed, BRIEF_NOTEBOOK_CHARS, `read the rest of ${rel} yourself before acting`);
  }
  const kept = trimmed.slice(0, cut);
  const next = kept.split('\n').length + 1;
  const total = trimmed.split('\n').length;
  return (
    `${kept}\n…(lines 1–${next - 1} of ${total} shown — read the rest of ${rel} from line ` +
    `${next} (Read offset=${next}) before acting, not from the top)`
  );
}

/**
 * Оглавление справочной заметки: первая строка, заголовки `## ` и путь к телу.
 * `# ` внутри тела — нумерованный список разметки Jira, не заголовок.
 */
export function referenceIndex(text: string, rel: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= BRIEF_REFERENCE_WHOLE) return trimmed;
  const heads = trimmed.split('\n').filter((line, i) => i === 0 || line.startsWith('## '));
  return [
    ...heads,
    `…(index only, ${trimmed.length} chars in the file — Read ${rel} for a section the work needs)`,
  ].join('\n');
}

// Только хвост: ведущий пробел у кода статуса — смысл (« M» — правка не в
// индексе, «M » — в индексе).
function clipLines(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.length > BRIEF_GIT_LINES
    ? [...lines.slice(0, BRIEF_GIT_LINES), `…(${lines.length - BRIEF_GIT_LINES} more lines)`].join(
        '\n',
      )
    : lines.join('\n');
}

/** Файл из `git diff --numstat -z`: у переименования — и откуда; `null` в счётчиках — бинарный. */
type DiffEntry = { path: string; from?: string; added: number | null; deleted: number | null };
/** Запись `git status --porcelain -z`: код XY, путь, у переименования/копии — откуда. */
type StatusEntry = { code: string; path: string; from?: string };

const count = (raw: string): number | null => (raw === '-' ? null : Number(raw));

export function parseNumstatZ(out: string): DiffEntry[] {
  const tokens = out.split('\0');
  const entries: DiffEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[index]!);
    if (!match) continue;
    const [, added, deleted, path] = match;
    const counts = { added: count(added!), deleted: count(deleted!) };
    if (path) {
      entries.push({ path, ...counts });
      continue;
    }
    // Переименование: пустой путь, затем «откуда» и «куда» отдельными полями.
    entries.push({ from: tokens[index + 1] ?? '', path: tokens[index + 2] ?? '', ...counts });
    index += 2;
  }
  return entries;
}

export function parseStatusZ(out: string): StatusEntry[] {
  const tokens = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.length < 4) continue;
    const entry: StatusEntry = { code: token.slice(0, 2), path: token.slice(3) };
    // У R/C за путём «куда» следует путь «откуда».
    if (/[RC]/.test(entry.code)) {
      entry.from = tokens[index + 1] ?? '';
      index += 1;
    }
    entries.push(entry);
  }
  return entries;
}

const named = (path: string, from?: string): string => (from ? `${from} -> ${path}` : path);

/**
 * Изменённое от базы и незакоммиченное — ОДНИМ списком. Раньше шли два: `git diff
 * --stat` от базы (рабочее дерево против базы — незакоммиченное в нём уже есть) и
 * `git status --short`; у копии посреди rebase это одни и те же пути дважды (g8,
 * 26.10: 2,5k + 3,2k одной вводной). Теперь путь в обоих — одна строка с кодом
 * статуса слева; пусто слева — закоммичен и в дереве чист. Только в статусе
 * (неотслеживаемые, вернувшиеся к базе) — своим коротким списком. Счётчики,
 * переименования и бинарные остаются видны; `--numstat -z` даёт полные пути без
 * кавычек — `--stat` обрезал длинные до «…/» и сверить их было не с чем.
 */
export function changedFacts(
  ref: string | undefined,
  numstat: string | undefined,
  status: string | undefined,
): string[] {
  const parts: string[] = [];
  const tree = status === undefined ? undefined : parseStatusZ(status);
  const codes = new Map((tree ?? []).map((entry) => [entry.path, entry]));
  const listed = new Set<string>();
  const diff = ref && numstat ? parseNumstatZ(numstat) : [];
  if (ref && diff.length) {
    let added = 0;
    let deleted = 0;
    const rows = diff.map((entry) => {
      listed.add(entry.path);
      added += entry.added ?? 0;
      deleted += entry.deleted ?? 0;
      const own = codes.get(entry.path);
      const counts = entry.added === null ? 'bin' : `+${entry.added} -${entry.deleted}`;
      const line = `${own?.code ?? '  '} ${named(entry.path, entry.from ?? own?.from)} ${counts}`;
      return { line, uncommitted: Boolean(own) };
    });
    const dirty = rows.filter((row) => row.uncommitted).length;
    // Всё закоммичено — список файлов ветки новой сессии почти не нужен: 105 строк
    // «0 of them uncommitted» стоили 3,1k знаков вводной (g8 26.10, F12). Тогда 10 строк;
    // есть незакоммиченное — прежние 40.
    const limit = tree && dirty === 0 ? BRIEF_CLEAN_DIFF_LINES : BRIEF_GIT_LINES;
    const hidden = rows.slice(limit);
    // git status не ответил — пустая колонка не значит «закоммичен»: так и сказано.
    parts.push(
      `## Changed vs ${ref} (working tree vs base, git diff --numstat; ` +
        (tree
          ? 'left column = git status --short code, blank = committed and clean)'
          : 'git status did not answer — what is uncommitted is unknown)'),
      `${rows.length} files, +${added} -${deleted}` +
        (tree ? `; ${dirty} of them uncommitted` : ''),
      ...rows.slice(0, limit).map((row) => row.line),
    );
    if (hidden.length) {
      const hiddenDirty = hidden.filter((row) => row.uncommitted).length;
      parts.push(
        `…(${hidden.length} more files${tree ? `, ${hiddenDirty} of them uncommitted` : ''})`,
      );
    }
  }
  if (!tree) return parts;
  const rest = tree.filter((entry) => !listed.has(entry.path));
  if (!tree.length) parts.push('## Uncommitted (git status --short)', 'clean');
  else if (rest.length) {
    parts.push(
      listed.size
        ? '## Uncommitted, not in the list above (git status --short)'
        : '## Uncommitted (git status --short)',
      clipLines(rest.map((entry) => `${entry.code} ${named(entry.path, entry.from)}`).join('\n')),
    );
  }
  return parts;
}

/** Последний текст модели в транскрипте: итог прежней стадии. */
export function lastAnswer(transcript: string): string {
  const records = readTailRecords(transcript);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.type !== 'assistant') continue;
    const text = textOf(record);
    if (text.trim()) return text;
  }
  return '';
}

const isToolResultOnly = (record: { message?: { content?: unknown } }): boolean => {
  const content = record.message?.content;
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => (block as { type?: string }).type === 'tool_result')
  );
};

/**
 * Ход, оборванный посреди работы (пауза, перезапуск, смерть CLI): его последний
 * вызов — инструмент, итога нет. Найденное в нём — причина, вывод — лежит в
 * тексте МЕЖДУ вызовами; последний такой текст — часто «запускаю ещё раз», а
 * причина — на абзац раньше (23.10: найденная причина зависания cpSync 68,5 с
 * пропала с паузой, новая сессия искала её заново). Тексты этого хода, новые
 * последними; закончился ход итогом — пусто: итог несёт `lastAnswer`.
 */
export function interruptedStretch(transcript: string, max = BRIEF_LAST_ANSWER_CHARS): string {
  const records = readTailRecords(transcript);
  const texts: string[] = [];
  let endedWithTool = false;
  let seenAssistant = false;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.type === 'user') {
      if (isToolResultOnly(record)) continue;
      if (textOf(record).trim()) break;
      continue;
    }
    if (record.type !== 'assistant') continue;
    const content = record.message?.content;
    const tool = Array.isArray(content) && content.some((block) => block.type === 'tool_use');
    if (!seenAssistant) endedWithTool = tool && !textOf(record).trim();
    seenAssistant = true;
    const text = textOf(record).trim();
    if (text) texts.unshift(text);
  }
  if (!endedWithTool || texts.length < 2) return '';
  const joined = texts.join('\n…\n');
  return joined.length > max ? `…${joined.slice(-max)}` : joined;
}

/**
 * Неотвеченный `AskUserQuestion` прежнего разговора — вопрос и варианты.
 * Ответ человека приходит новым ходом («Вариант A»), а вызов вопроса остался в
 * старой сессии: без него новая сессия не знает, на что ей ответили. Вопрос
 * текстом уже лежит в последнем ответе.
 */
function openQuestion(transcript: string): string {
  const input = lastAskedInputIn(transcript) as
    { questions?: { question?: unknown; options?: { label?: unknown }[] }[] } | undefined;
  const lines: string[] = [];
  for (const item of input?.questions ?? []) {
    if (typeof item.question !== 'string') continue;
    const labels = (item.options ?? [])
      .map((option) => option.label)
      .filter((label): label is string => typeof label === 'string');
    lines.push(`- ${item.question}${labels.length ? ` Options: ${labels.join(' | ')}` : ''}`);
  }
  return lines.join('\n');
}

/** Потолок `ls-remote` вводной: синхронный вызов, сеть не должна держать панель дольше. */
const REMOTE_READ_MS = 8_000;
/** Сколько чужих коммитов удалённого назвать. */
const REMOTE_AHEAD_SHOWN = 5;

/**
 * Где ветка группы на удалённом против HEAD копии — по самому удалённому (`ls-remote`),
 * не по устаревшей `origin/<ветка>` копии (g8 26.10, F3/F12): бот CI дописал в ветку
 * коммит, вводная перечислила только локальные коммиты, и новая сессия сняла MR с
 * черновика, считая, что голова MR — её HEAD. Удалённый не ответил — раздела нет.
 */
export function remoteFacts(cwd: string, branch: string): string[] {
  const remotes = (gitSync(cwd, ['remote']) ?? '').split('\n').map((name) => name.trim());
  const remote = remotes.includes('origin') ? 'origin' : remotes.find(Boolean);
  if (!remote) return [];
  const listing = gitSync(cwd, ['ls-remote', remote, `refs/heads/${branch}`], REMOTE_READ_MS);
  if (listing === undefined) return [];
  const sha = listing.trim().split(/\s+/)[0] ?? '';
  const head = gitSync(cwd, ['rev-parse', 'HEAD'])?.trim() ?? '';
  const title = `## Remote ${remote}/${branch} (read from the remote now)`;
  if (!sha) return [title, `not on ${remote} — the branch is not pushed yet`];
  if (sha === head) return [title, '= HEAD of the copy (pushed, nothing new on the remote)'];
  const known = gitSync(cwd, ['cat-file', '-t', sha])?.trim() === 'commit';
  if (!known) {
    return [
      title,
      `at ${sha.slice(0, 9)}, a commit this copy does not have: someone (often CI) pushed to the ` +
        `branch — git fetch ${remote} ${branch}, look at it, then git pull --ff-only ${remote} ` +
        `${branch} before you push or take the MR out of draft`,
    ];
  }
  const ahead = gitSync(cwd, ['log', '--format=%h %s (%an)', `${head}..${sha}`])?.trim() ?? '';
  const behind = gitSync(cwd, ['rev-list', '--count', `${sha}..${head}`])?.trim() ?? '0';
  if (!ahead) return [title, `behind HEAD by ${behind} commit(s) — push pending`];
  const lines = ahead.split('\n');
  const shown = lines.slice(0, REMOTE_AHEAD_SHOWN).map((line) => `- ${line}`);
  const more = lines.length > shown.length ? [`…(+${lines.length - shown.length})`] : [];
  return [
    title,
    behind === '0'
      ? `AHEAD of the copy by ${lines.length} commit(s) not made here — the MR head is the ` +
        `remote, not your HEAD; git pull --ff-only ${remote} ${branch} first, check they do not ` +
        'revert your changes:'
      : `diverged from HEAD: ${lines.length} commit(s) only on the remote, ${behind} only here:`,
    ...shown,
    ...more,
  ];
}

function mergeBase(cwd: string, own?: string): { ref: string; sha: string } | undefined {
  // Копия от ветки предшественника (`base` группы с `after`) считает своё от неё:
  // от origin/HEAD в «коммиты группы» попали бы и его коммиты (F-25 ревью П1).
  const refs = own ? [own, `origin/${own}`, ...BASE_REFS] : BASE_REFS;
  for (const ref of refs) {
    const sha = gitSync(cwd, ['merge-base', 'HEAD', ref])?.trim();
    if (sha) return { ref, sha };
  }
  return undefined;
}

/**
 * Блок фактов для вводной: заметки, git от базы вместе с незакоммиченным, последний
 * ответ и путь к прежнему транскрипту. Пустой раздел не печатается. `base` —
 * ветка, от которой отведена копия группы; нет — основная ветка origin.
 *
 * `read` — у чужого CLI (Codex, Qwen Code): последний ответ и открытый вопрос
 * его разговор приносит сам, транскрипт Claude не читается. Без `read` — как было.
 */
export function coldBriefFacts(
  cwd: string,
  transcript: string,
  base?: string,
  read?: { lastAnswer?: string; openQuestion?: string },
): string {
  // Отметка времени снимает противоречие с продолжениями «сверь состояние с фактами
  // (git status, git log)»: факты ниже — на этот миг, git — только о том, что после.
  const parts: string[] = [
    `Facts the panel collected for you at ${new Date().toISOString()} — current as of then; ` +
      'do not collect them again, run git only for what changed after:',
  ];
  const branch = gitSync(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  for (const rel of NOTEBOOK_FILES) {
    const file = join(cwd, rel);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (!text.trim()) continue;
    parts.push(
      `## Notebook ${rel}`,
      REFERENCE_NOTEBOOKS.has(rel) ? referenceIndex(text, rel) : clipNotebook(text, rel),
    );
    // Заметка состояния, написанная до rebase/push, спорит с коммитами ниже (F-11).
    const checked = STATE_NOTEBOOKS.has(rel) ? notebookVsGit(cwd, text, branch) : '';
    if (checked) parts.push(checked);
  }
  const fork = mergeBase(cwd, base);
  const log = fork
    ? gitSync(cwd, ['log', '--oneline', '-n', '15', `${fork.sha}..HEAD`])
    : gitSync(cwd, ['log', '--oneline', '-n', '10']);
  if (log?.trim()) {
    parts.push(
      `## Commits on ${branch ?? 'HEAD'}${fork ? ` since ${fork.ref}` : ''}`,
      clipLines(log),
    );
  }
  const remote = branch && branch !== 'HEAD' ? remoteFacts(cwd, branch) : [];
  parts.push(...remote);
  const numstat = fork ? gitSync(cwd, ['diff', '--numstat', '-z', fork.sha]) : undefined;
  parts.push(...changedFacts(fork?.ref, numstat, gitSync(cwd, ['status', '--porcelain', '-z'])));
  // Оборванный ход — его тексты целиком (последний среди них); иначе — итог хода.
  const stretch = read ? '' : interruptedStretch(transcript);
  const answer = stretch ? '' : read ? (read.lastAnswer ?? '') : lastAnswer(transcript);
  if (answer) {
    parts.push(
      '## Your last answer in the previous conversation',
      clip(
        answer,
        BRIEF_LAST_ANSWER_CHARS,
        'the rest is the last answer in the previous transcript',
      ),
    );
  }
  if (stretch) {
    parts.push(
      '## The previous turn broke off mid-work — what you found and said in it (newest last; a ' +
        'cause found here is a fact, do not search for it again)',
      stretch,
    );
  }
  const asked = read ? (read.openQuestion ?? '') : openQuestion(transcript);
  if (asked) {
    parts.push(
      '## Your question still open in the previous conversation (the message below may answer it)',
      clip(asked, BRIEF_LAST_ANSWER_CHARS, 'the rest is in the previous transcript'),
    );
  }
  parts.push(
    `Previous transcript: ${transcript} — grep it for one missing detail; never read it whole.`,
  );
  return parts.join('\n');
}
