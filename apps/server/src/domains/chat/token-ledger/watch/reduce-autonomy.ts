import { createHash } from 'node:crypto';
import { write1hPart } from '../../../analytics/token-audit/window-weight.ts';
import { commandPrint, commandSteps, gitVerb } from './check-signature.ts';
import { absolutePath, capped, normPath, str, under } from './reduce-util.ts';
import { bare, words } from './shell-targets.ts';
import type {
  EditIntent,
  FreshCause,
  WatchContext,
  WatchEvent,
  WatchState,
} from './watch.types.ts';

/**
 * Поводы правил R34 и R35 (пробелы автономии 24.10): новый разговор, заново
 * записавший окно поверх тёплого, и правки, которые уже лежат в коммите. Чистые
 * функции над состоянием сессии: `reduce.ts` зовёт их на своих событиях.
 */

/** Новых разговоров поверх тёплого держим немного: правило-событие смотрит последний. */
const FRESH_CAP = 10;
/** Правок между коммитами — до двух сотен: дальше вытесняется давнее. */
const INTENTS_CAP = 200;
/** Коммитов, ещё не перенесённых сторожем, — горсть: сторож забирает их на каждом событии. */
const FACTS_CAP = 20;
/** Строки короче — скобки и пустые хвосты: совпадают у любых двух файлов. */
const MIN_LINE = 4;
/** Перезапись файла — повтор, если столько его строк уже были в закоммиченном (R35). */
export const WRITE_OVERLAP = 0.6;
/** Правка текстом короче — `}`, `import`, однострочник: совпасть может с чем угодно. */
const MIN_EDIT_CHARS = 40;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
/** Правка файла командой: путь — последнее слово шага. */
const SHELL_EDIT = /^(?:sed\s+(?:-\S+\s+)*-i|perl\s+-\S*i)/;

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

// ─── R34: новый разговор поверх тёплого ─────────────────────────────────────

/**
 * Начало хода. Новый разговор группы с прошлым ещё тёплым (пауза от последнего
 * вызова прошлого не дольше `coldGapMinutes`) открывает запись: её первый ход
 * копит запись кэша. Любое начало хода закрывает прежнюю открытую запись.
 */
export function noteFreshStart(
  state: WatchState,
  event: Extract<WatchEvent, { kind: 'start' }>,
  ctx: WatchContext,
): void {
  closeFresh(state);
  const { prev, cause } = event;
  if (!event.fresh || !prev || !cause) return;
  if (event.t - prev.t > ctx.settings.coldGapMinutes * 60_000) return;
  capped(
    state.freshRewrites,
    {
      at: event.t,
      write: 0,
      write1h: 0,
      prevCtx: prev.ctx,
      ...(prev.model ? { model: prev.model } : {}),
      cause,
      open: true,
    },
    FRESH_CAP,
  );
}

/** Вызов первого хода нового разговора — его запись кэша в счёт пересборки окна. */
export function noteFreshCall(
  state: WatchState,
  event: Extract<WatchEvent, { kind: 'call' }>,
): void {
  const open = state.freshRewrites.at(-1);
  if (!open?.open) return;
  open.write += event.cacheWrite;
  open.write1h += write1hPart(event.cacheWrite, event.cacheWrite1h);
  if (event.model) open.model = event.model;
}

/** Конец хода: первый ход нового разговора кончился, пересборка окна посчитана. */
export function closeFresh(state: WatchState): void {
  const open = state.freshRewrites.at(-1);
  if (open?.open) delete open.open;
}

/**
 * Смена модели на тёплом продолжении: кэш другой модели не читается, и окно пишется
 * заново, хотя пауза короче срока остывания. Это не холодное продолжение (R2), а
 * лишний новый старт (R34, не нужный). Решает `reduce.ts` — здесь только запись.
 */
export function noteModelSwitch(
  state: WatchState,
  event: Extract<WatchEvent, { kind: 'call' }>,
  prevCtx: number,
): void {
  closeFresh(state);
  const cause: FreshCause = 'model-switch';
  capped(
    state.freshRewrites,
    {
      at: event.t,
      write: event.cacheWrite,
      write1h: write1hPart(event.cacheWrite, event.cacheWrite1h),
      prevCtx,
      ...(event.model ? { model: event.model } : {}),
      cause,
    },
    FRESH_CAP,
  );
}

// ─── R35: правки, уже лежащие в коммите ─────────────────────────────────────

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_LINE);

/**
 * Что вносит вызов правки (R35): путь и отпечатки. Edit — новый текст целиком (одна
 * правка того же места тем же текстом), Write — строки файла, `sed -i` — шаг команды.
 * Не правка или правка слишком короткая, чтобы совпадение что-то значило, — нет.
 */
export function editIntentOf(
  event: Extract<WatchEvent, { kind: 'tool' }>,
  ctx: WatchContext,
): EditIntent | undefined {
  if (EDIT_TOOLS.has(event.name)) {
    const raw = str(event.input.file_path) ?? str(event.input.notebook_path);
    const path = raw ? absolutePath(raw, ctx) : undefined;
    if (!path) return undefined;
    if (event.name === 'Write') {
      const sig = [...new Set(lines(str(event.input.content) ?? '').map(hash))];
      return sig.length > 0 ? { path, shown: raw ?? path, kind: 'write', sig } : undefined;
    }
    const edits =
      event.name === 'MultiEdit' && Array.isArray(event.input.edits)
        ? (event.input.edits as Array<Record<string, unknown>>)
        : [event.input];
    const sig = edits
      .map((edit) => str(edit.new_string) ?? '')
      .filter((text) => text.trim().length >= MIN_EDIT_CHARS)
      .map(hash);
    return sig.length > 0 ? { path, shown: raw ?? path, kind: 'edit', sig } : undefined;
  }
  if (event.name !== 'Bash') return undefined;
  const command = str(event.input.command);
  if (!command) return undefined;
  for (const step of commandSteps(command).map(bare)) {
    if (!SHELL_EDIT.test(step)) continue;
    const target = words(step).at(-1);
    const path = target ? absolutePath(target, ctx) : undefined;
    const print = commandPrint(step);
    if (target && path && print) return { path, shown: target, kind: 'shell', sig: [print] };
  }
  return undefined;
}

/**
 * Правка повторяет закоммиченную: тот же путь и то же внесённое — тот же новый текст
 * Edit, тот же шаг команды, или перезапись файла, где не меньше `WRITE_OVERLAP` строк
 * уже были в его закоммиченной перезаписи. Правка рядом (новая проверка возле
 * старой, строка в закоммиченной функции) — другой текст, не повтор.
 */
export function repeats(intent: EditIntent, committed: readonly EditIntent[]): boolean {
  return committed.some((done) => {
    if (done.path !== intent.path || done.kind !== intent.kind) return false;
    if (intent.kind !== 'write') return intent.sig.some((sig) => done.sig.includes(sig));
    const known = new Set(done.sig);
    const same = intent.sig.filter((sig) => known.has(sig)).length;
    return same / intent.sig.length >= WRITE_OVERLAP;
  });
}

/** Пути шага `git add`/`git commit` после ключей; `-A`, `.`, `--all`, `-u`, `-a` — всё дерево. */
function addPaths(rest: string, ctx: WatchContext): string[] | 'all' {
  const out: string[] = [];
  for (const word of words(rest)) {
    if (/^(?:-A|-u|--all|--update|\.|:\/)$/.test(word)) return 'all';
    if (word.startsWith('-')) continue;
    const path = absolutePath(word, ctx);
    if (path) out.push(normPath(path));
  }
  return out;
}

/**
 * Пути `git commit`: `-a`/`--all` — всё отслеживаемое; пути — только после `--`: текст
 * сообщения (`-m "$(cat <<EOF …)"`) разбирается словами, и его слова путями не считаются.
 */
function commitPaths(rest: string, ctx: WatchContext): string[] | 'all' {
  const list = words(rest);
  if (list.some((word) => /^-[A-Za-z]*a[A-Za-z]*$|^--all$/.test(word))) return 'all';
  const dash = list.indexOf('--');
  if (dash < 0) return [];
  const out: string[] = [];
  for (const word of list.slice(dash + 1)) {
    const path = absolutePath(word, ctx);
    if (path) out.push(normPath(path));
  }
  return out;
}

/**
 * Вызов Bash: `git add` копит подготовленное, `git commit` ждёт ответа. Пути коммита —
 * названные в самой команде, иначе подготовленное раньше, иначе неизвестно (все правки).
 */
export function noteGitWork(
  state: WatchState,
  event: Extract<WatchEvent, { kind: 'tool' }>,
  ctx: WatchContext,
): void {
  if (event.name !== 'Bash') return;
  const command = str(event.input.command);
  if (!command || !/\bgit\b/.test(command)) return;
  let paths: string[] | 'all' | undefined;
  let commit = false;
  for (const step of commandSteps(command).map(bare)) {
    const git = gitVerb(step);
    if (!git) continue;
    if (git.verb === 'add') {
      const added = addPaths(git.rest, ctx);
      state.staged =
        added === 'all' || state.staged === 'all' ? 'all' : [...(state.staged ?? []), ...added];
    }
    if (git.verb === 'commit' && !/--dry-run|--amend/.test(git.rest)) {
      commit = true;
      const named = commitPaths(git.rest, ctx);
      paths = named === 'all' || named.length > 0 ? named : state.staged;
    }
  }
  if (commit) state.pendingCommits[event.id] = { paths };
}

/**
 * Ответ на `git commit`: без ошибки — правки, вошедшие в коммит, становятся фактом
 * коммита (сторож переносит его в список группы), прочие ждут следующего.
 */
export function noteCommitResult(
  state: WatchState,
  event: Extract<WatchEvent, { kind: 'toolResult' }>,
): void {
  const pending = state.pendingCommits[event.id];
  if (!pending) return;
  delete state.pendingCommits[event.id];
  if (event.isError || event.denied) return;
  const { paths } = pending;
  // Путь коммита — файл или каталог (`git add widget/packages`): правка под каталогом — в коммите.
  const inCommit = (intent: EditIntent): boolean =>
    paths === undefined ||
    paths === 'all' ||
    paths.some((path) => under(normPath(intent.path), path));
  const intents = state.editIntents.filter(inCommit);
  state.editIntents = state.editIntents.filter((intent) => !inCommit(intent));
  delete state.staged;
  if (intents.length > 0) capped(state.commitFacts, { at: event.t, intents }, FACTS_CAP);
}

/** Вызов правки — в список правок до коммита. */
export function noteEditIntent(state: WatchState, intent: EditIntent | undefined): void {
  if (intent) capped(state.editIntents, intent, INTENTS_CAP);
}
