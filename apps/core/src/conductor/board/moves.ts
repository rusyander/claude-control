import {
  BOARD_MERGE_MAX,
  type BoardEntry,
  type BoardEntryDraft,
  type BoardEntryState,
  type BoardMove,
  type BoardMoveTo,
  type BoardStop,
} from '@agentdeck/contracts/core/board';
import {
  INTAKE_SOURCES_MAX,
  intakeSourceSchema,
  type IntakeSource,
} from '@agentdeck/contracts/core/intake';
import { REVIEW_LINK_PRESET } from '@agentdeck/contracts/core/review-link';
import { ANSWER_REVIEWERS_PRESET } from '../estimate/estimate.ts';
import { CHAT_PRESET } from '../estimate/placement.ts';
import { mergedRelated } from '../inbox/related.ts';
import { GROUP_MIXED_PROBLEM } from '../intake/group.ts';
import { isPresetId } from '../scenario/presets.ts';
import type { BoardFile } from './store.types.ts';

/**
 * Ходы человека на доске (этап 12, P152): колонка стадии — факт журнала, её руками не двигают.
 * Человек решает только то, что до задачи: входящие → очередь или «в работу» (голова очереди),
 * отклонить, вернуть из отклонённых, порядок очереди (= приоритет) и входящих, объединить записи
 * «Входящих» в одну (`merge`, D26 — только этим ходом, сам ядро не сливает никогда). Карточка задачи
 * ходов доски не имеет: перехват, возврат, доработка, остановка и отмена — команды задачи.
 * Ход вне списка — отказ 409 со списком разрешённых, а не тихое «ничего».
 */

export type MoveRefusal = {
  status: 404 | 409;
  code: 'unknown-card' | 'move-not-allowed';
  allowed: BoardMoveTo[];
  reason: string;
};

const ALLOWED: Record<BoardEntryState, readonly BoardMoveTo[]> = {
  // `merge` — только во «Входящих» (D26, P186): запись в очереди человек уже ставил тем снимком.
  inbox: ['queue', 'work', 'rejected', 'inbox', 'set-preset', 'merge'],
  queued: ['queue', 'work', 'inbox', 'rejected', 'set-preset'],
  rejected: ['restore'],
  // Старт начат или задача есть: дальше ведёт журнал задачи, не доска.
  starting: [],
  started: [],
};

/** Разрешённые ходы записи сейчас — тот же список, что видит панель на карточке. */
export function allowedMoves(entry: Pick<BoardEntry, 'state'>): BoardMoveTo[] {
  return [...ALLOWED[entry.state]];
}

/** В какое состояние ведёт ход: `work` — та же очередь, только голова. */
function targetOf(to: BoardMoveTo): BoardEntryState {
  switch (to) {
    case 'queue':
    case 'work':
      return 'queued';
    case 'rejected':
      return 'rejected';
    default:
      return 'inbox';
  }
}

/** Ранг в колонке `state` без записи `self`: голова, хвост или перед `before`. */
export function rankIn(
  entries: readonly BoardEntry[],
  state: BoardEntryState,
  self: string,
  place: { head: true } | { before: string } | { tail: true },
): number | { refused: string } {
  const column = entries.filter((e) => e.state === state && e.entryId !== self);
  if (column.length === 0) return 0;
  const ranks = column.map((e) => e.rank);
  if ('head' in place) return Math.min(...ranks) - 1;
  if ('tail' in place) return Math.max(...ranks) + 1;
  const anchor = column.find((e) => e.entryId === place.before);
  if (!anchor) return { refused: `entry ${place.before} is not in the ${state} column` };
  // Сосед сверху — ближайший с меньшим рангом; нет — на единицу выше якоря.
  const above = ranks.filter((r) => r < anchor.rank);
  if (above.length === 0) return anchor.rank - 1;
  return (Math.max(...above) + anchor.rank) / 2;
}

/**
 * Чего доска не принимает в запись: чат (разговор, не задача доски), ревью по ссылке без ссылки и
 * ссылку без пресета ревью, пункты группы вперемешку с другими источниками, неизвестный пресет и
 * ответы ревьюерам (их открывает опрос форжа по своему MR, не человек). Пусто — годна.
 */
export function draftProblems(draft: BoardEntryDraft, index: number): string[] {
  const at = `entries[${index}]`;
  if (draft.preset === CHAT_PRESET) return [`${at}: a chat is not a board task`];
  if (draft.preset === ANSWER_REVIEWERS_PRESET)
    return [`${at}: answer-reviewers tasks are opened by the forge poll, not from the board`];
  // Сценарий библиотеки пресета не имеет: запись несёт его id подписью, а старт разрешает сценарий
  // тем же `resolveScenario`, что и оценка. Подпись, не совпавшая со сценарием полей, — отказ.
  if (!isPresetId(draft.preset) && libraryIdOf(draft) !== draft.preset)
    return [`${at}: unknown preset ${draft.preset}`];
  if (draft.launch.kind === 'link')
    return draft.preset === REVIEW_LINK_PRESET
      ? []
      : [`${at}: a link launch needs the ${REVIEW_LINK_PRESET} preset`];
  if (draft.preset === REVIEW_LINK_PRESET)
    return [`${at}: the ${REVIEW_LINK_PRESET} preset starts from a link launch`];
  // Группа — ОДНА запись со всеми пунктами (`group-item`): её старт идёт путём оценки группы и
  // ставит задачу на пункт под общим `groupId`. Смесь пунктов с другими источниками не группа и не
  // одна задача — та же причина, что у ручки оценки.
  const sources = draft.launch.fields.sources;
  if (Array.isArray(sources) && sources.some(isGroupItem) && !sources.every(isGroupItem))
    return [`${at}: ${GROUP_MIXED_PROBLEM}`];
  return [];
}

/** Id сценария библиотеки из полей запуска (`scenario: {id, version}`); пресет или ссылка — нет. */
function libraryIdOf(draft: BoardEntryDraft): string | undefined {
  if (draft.launch.kind !== 'fields') return undefined;
  const scenario = draft.launch.fields.scenario;
  if (typeof scenario !== 'object' || scenario === null || Array.isArray(scenario))
    return undefined;
  return 'id' in scenario && typeof scenario.id === 'string' ? scenario.id : undefined;
}

/**
 * Чего не хватает записи для пресета `preset` (W2-D, P164): те же отказы, что у новой записи,
 * плюс предпосылки самого пресета — `ask` создаёт только своя ручка, задача из трекера требует
 * снимка тикета, запись со сценарием библиотеки меняет сценарий формой запуска. Пусто — можно.
 */
export function presetChangeProblems(entry: BoardEntry, preset: string): string[] {
  if (preset === 'ask') return ['the ask preset is created only by its own route, not the board'];
  const library = libraryIdOf(entry);
  if (library !== undefined)
    return [`the entry runs library scenario ${library}; change it in the launch form`];
  const own = draftProblems({ ...entry, preset }, 0).map((p) => p.replace(/^entries\[0\]: /, ''));
  if (own.length > 0) return own;
  if (preset === 'tracker-ticket' && !hasTrackerSnapshot(entry))
    return [
      'the tracker-ticket preset needs a tracker snapshot in the launch source (kind tracker)',
    ];
  return [];
}

function hasTrackerSnapshot(entry: BoardEntry): boolean {
  if (entry.launch.kind !== 'fields') return false;
  const { source, sources } = entry.launch.fields;
  const all = [source, ...(Array.isArray(sources) ? sources : [])];
  return all.some(
    (s) => typeof s === 'object' && s !== null && 'kind' in s && s.kind === 'tracker',
  );
}

function isGroupItem(source: unknown): boolean {
  return typeof source === 'object' && source !== null && 'kind' in source
    ? source.kind === 'group-item'
    : false;
}

/**
 * Новые записи в колонку `to` по порядку тела, хвостом. В очередь — с доказательством человека
 * (этот ход); во входящие — без: их ставит в очередь следующий ход человека.
 */
export function addEntries(
  file: BoardFile,
  input: { cmdId: string; to: 'inbox' | 'queue'; entries: readonly BoardEntryDraft[] },
  at: number,
  defaultStop: BoardStop,
  newId: () => string,
): string[] {
  const state: BoardEntryState = input.to === 'queue' ? 'queued' : 'inbox';
  const created: string[] = [];
  for (const draft of input.entries) {
    const entryId = newId();
    const rank = rankIn(file.entries, state, entryId, { tail: true }) as number;
    file.entries.push({
      entryId,
      state,
      rank,
      stop: draft.stop ?? defaultStop,
      preset: draft.preset,
      source: draft.source,
      launch: draft.launch,
      ...(state === 'queued' ? { proof: { kind: 'human' as const, cmdId: input.cmdId, at } } : {}),
      createdAt: at,
      ...(draft.paidOnRefusal === undefined ? {} : { paidOnRefusal: draft.paidOnRefusal }),
    });
    created.push(entryId);
  }
  return created;
}

function placeOf(move: BoardMove): { head: true } | { before: string } | { tail: true } {
  if (move.to === 'work') return { head: true };
  if (move.before !== undefined) return { before: move.before };
  return { tail: true };
}

/**
 * Применить ход к копии файла доски. Ход с `taskId` — карточка задачи: ходов доски у неё нет.
 * `at` — стена хода: она же время доказательства человека (P183).
 */
export function applyMove(
  file: BoardFile,
  move: BoardMove,
  at: number,
): { ok: true } | ({ ok: false } & MoveRefusal) {
  if (move.taskId !== undefined) {
    const known = file.entries.some((e) => e.taskId === move.taskId);
    return {
      ok: false,
      status: 409,
      code: 'move-not-allowed',
      allowed: [],
      reason: known
        ? 'a started task moves by its journal; use the task commands (take-over, rework, set-stop, cancel)'
        : 'a task card has no board moves; use the task commands (take-over, rework, set-stop, cancel)',
    };
  }
  const entry = file.entries.find((e) => e.entryId === move.entryId);
  if (!entry)
    return {
      ok: false,
      status: 404,
      code: 'unknown-card',
      allowed: [],
      reason: `no board entry ${move.entryId}`,
    };
  const allowed = allowedMoves(entry);
  const refuse = (reason: string) =>
    ({ ok: false, status: 409, code: 'move-not-allowed', allowed, reason }) as const;
  if (!allowed.includes(move.to))
    return refuse(`move ${move.to} is not allowed from ${entry.state}`);
  if (move.before !== undefined && move.to !== 'queue' && move.to !== 'inbox')
    return refuse(`"before" orders only the queue or the inbox, not ${move.to}`);
  if (move.to === 'set-preset') {
    // Пресет до старта (P164): колонка и ранг те же; отказ называет недостающую предпосылку.
    const preset = move.preset ?? '';
    const problems = presetChangeProblems(entry, preset);
    if (problems.length > 0) return refuse(`preset ${preset}: ${problems.join('; ')}`);
    entry.preset = preset;
    // Причина стояния относилась к прежнему пресету — запускатель назовёт новую, если она есть.
    delete entry.reason;
    // Запись в очереди теперь стоит словом этого хода: прежний ход разрешал старт другим пресетом.
    if (entry.state === 'queued') entry.proof = { kind: 'human', cmdId: move.cmdId, at };
    return { ok: true };
  }
  if (move.to === 'merge') return applyMerge(file, entry, move.entryIds ?? [], refuse);
  const state = targetOf(move.to);
  const rank = rankIn(file.entries, state, entry.entryId, placeOf(move));
  if (typeof rank !== 'number') return refuse(rank.refused);
  entry.state = state;
  entry.rank = rank;
  delete entry.reason;
  if (state === 'queued') {
    // В очереди запись держит ход человека — он и есть доказательство старта (P183); перестановка
    // тоже его ход: запись, поставленная настройкой, после неё стоит уже словом человека.
    entry.proof = { kind: 'human', cmdId: move.cmdId, at };
  } else {
    // Из очереди назад — прежнее доказательство больше ничего не разрешает.
    delete entry.proof;
  }
  return { ok: true };
}

type Refuse = (reason: string) => { ok: false } & MoveRefusal;

/** Снимки тикетов в полях запуска записи (`source` или `sources`); не тикетная запись — причина. */
function ticketSourcesOf(entry: BoardEntry): IntakeSource[] | { refused: string } {
  const what = `entry ${entry.entryId} (${entry.source.key ?? entry.source.kind})`;
  if (entry.launch.kind !== 'fields')
    return { refused: `${what} starts from its MR link; an MR entry does not merge` };
  const { source, sources } = entry.launch.fields;
  const raw = source === undefined ? sources : [source];
  if (!Array.isArray(raw) || raw.length === 0)
    return { refused: `${what} carries no ticket snapshot; only ticket entries merge` };
  const out: IntakeSource[] = [];
  for (const one of raw) {
    const parsed = intakeSourceSchema.safeParse(one);
    if (!parsed.success || parsed.data.kind === 'group-item')
      return { refused: `${what} carries no ticket snapshot; only ticket entries merge` };
    out.push(parsed.data);
  }
  return out;
}

/** Репозитории запуска без повторов по пути: свои первыми, затем сложенных по порядку хода. */
function reposOf(entries: readonly BoardEntry[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const e of entries) {
    if (e.launch.kind !== 'fields' || !Array.isArray(e.launch.fields.repos)) continue;
    for (const repo of e.launch.fields.repos) {
      const path =
        typeof repo === 'object' && repo !== null && 'path' in repo ? String(repo.path) : '';
      if (path === '' || seen.has(path)) continue;
      seen.add(path);
      out.push(repo);
    }
  }
  return out;
}

/**
 * Ход человека `merge` (D26, P186): записи `ids` складываются в `target` — одна запись несёт
 * источники всех (`merged`, их ключи остаются занятыми: опрос не заводит их заново), снимки всех
 * тикетов (`sources` запуска — одна задача по всем) и объединённые факты связей; сложенные записи
 * уходят. Только записи «Входящих» и только тикетные (у MR-записи запуск — ссылка на один MR);
 * больше снимков, чем берёт одна оценка, — отказ, а не тихая потеря тикета.
 */
function applyMerge(
  file: BoardFile,
  target: BoardEntry,
  ids: readonly string[],
  refuse: Refuse,
): { ok: true } | ({ ok: false } & MoveRefusal) {
  if (ids.length === 0) return refuse('merge names no entries to fold');
  const folded: BoardEntry[] = [];
  for (const id of ids) {
    const one = file.entries.find((e) => e.entryId === id);
    if (!one)
      return {
        ok: false,
        status: 404,
        code: 'unknown-card',
        allowed: allowedMoves(target),
        reason: `no board entry ${id}`,
      };
    if (one.entryId === target.entryId) return refuse('an entry does not merge into itself');
    if (one.state !== 'inbox')
      return refuse(
        `entry ${id} (${one.source.key ?? one.source.kind}) is ${one.state}: only inbox entries merge`,
      );
    folded.push(one);
  }
  const snapshots: IntakeSource[] = [];
  for (const one of [target, ...folded]) {
    const got = ticketSourcesOf(one);
    if (!Array.isArray(got)) return refuse(got.refused);
    snapshots.push(...got);
  }
  if (snapshots.length > INTAKE_SOURCES_MAX)
    return refuse(
      `merge would carry ${snapshots.length} ticket snapshots; one task takes at most ${INTAKE_SOURCES_MAX}`,
    );
  const merged = [
    ...(target.merged ?? []),
    ...folded.flatMap((e) => [e.source, ...(e.merged ?? [])]),
  ];
  if (merged.length > BOARD_MERGE_MAX * 10)
    return refuse(
      `merge would fold ${merged.length} sources; an entry keeps at most ${BOARD_MERGE_MAX * 10}`,
    );
  const related = mergedRelated(target, folded);
  const repos = reposOf([target, ...folded]);
  if (target.launch.kind === 'fields') {
    const { source: _one, ...rest } = target.launch.fields;
    const fields: typeof target.launch.fields = { ...rest, sources: snapshots as never };
    if (repos.length > 0) fields.repos = repos as never;
    target.launch = { kind: 'fields', fields };
  }
  target.merged = merged;
  if (related) target.related = related;
  const gone = new Set(folded.map((e) => e.entryId));
  file.entries = file.entries.filter((e) => !gone.has(e.entryId));
  return { ok: true };
}
