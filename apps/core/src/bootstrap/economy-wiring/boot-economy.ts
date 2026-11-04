import { dirname } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { isSecretName } from '@agentdeck/dlp/secret-mask';
import type { AdapterRegistry } from '../../adapters/index.ts';
import { reviewBaseOf, unitCopyOf } from '../../conductor/copy/index.ts';
import type { RunEconomy } from '../../conductor/run/run.types.ts';
import type { PackFile, ReviewPackInput } from '../../context/review-pack/index.ts';
import { reviewInputsOf } from '../../context/review-pack/index.ts';
import { learnedCachePath, readLearned, type LearnedTable } from '../../economy/learned/index.ts';
import type { TierLadder } from '../../economy/tier.types.ts';
import type { WindowBook } from '../../economy/window/index.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { diffFileOf, diffUnit } from '../../platform/git.ts';
import type { ContourPolicy } from '../../policy/resolve/resolve.types.ts';
import type { SessionTokens } from '../../policy/session-tokens/session-tokens.ts';
import { journaledSessionDir } from '../conductor-wiring/session-start.ts';
import type { SessionKeyBook } from '../session-keys.ts';
import type { ContextWiring } from './context.ts';
import { createRunEconomy } from './continuation.ts';
import { laddersOf } from './ladders.ts';

/**
 * Экономика исполнителя в сборе (этап 5, W): `boot.ts` строит её один раз — та же книга окон, что
 * у крана потока и `/v1/health` (G7), та же проводка контекста, что у крана (дрейф первого хода),
 * одно выученное на ядро (его же берёт оценка деления, `history`). Здесь только чтения фактов:
 * секреты сеанса, транскрипт, вход пакета ревью; судьи — у владельцев.
 */

export interface BootEconomyDeps {
  /** Каталог задач дома ядра: выученное читается по законченным журналам рядом с кэшем. */
  tasksDir: string;
  windows: WindowBook;
  context: ContextWiring;
  adapters: AdapterRegistry;
  sessionTokens: SessionTokens;
  /** Пин окружения CLI — тот же, с которым исполнитель запускает сессию. */
  pin: () => Record<string, string>;
  /** Ключи маршрута, прочитанные дорогой для сеанса (P61); нет — только пин и токен. */
  keys?: Pick<SessionKeyBook, 'valuesOf'>;
  /**
   * Активный контур панели (уровень 1) — вход суда `tier`, читается на каждый шаг (s10 G7: смена
   * режима доходит без перезапуска); нет или `undefined` — набор задачи как есть.
   */
  contour?: () => ContourPolicy | undefined;
  /** Окно маршрута × модели — книга окон загрузки (`route-windows.ts`), та же у наблюдателя. */
  windowOf?: (routeId: string, model: string | null) => number | null;
  now?: () => number;
}

export interface BootEconomy {
  run: RunEconomy;
  /** Значения секретов сеанса (P61) — бриф, пакет ревью, `unit_diff` и `check` маскируют их. */
  known(taskId: string, sessionId: string): readonly string[];
  /** Перечитать выученное (оценка деления); прочитанное — и бюджету токенов исполнителя. */
  history(): Promise<LearnedTable | null>;
  /** Последнее прочитанное выученное без нового чтения (`null` — ещё не прочитано или истории нет). */
  learned(): LearnedTable | null;
  /**
   * Лестницы переходников загрузки — один источник: их судит `tier` каждого шага, ими же
   * загрузка ранжирует модели правки человека (`set-model`).
   */
  ladders: Readonly<Record<string, TierLadder>>;
}

/** Короче — не секрет, а совпадение: маска по значению съела бы обычные слова диффа. */
const MIN_KNOWN = 8;

/**
 * Секреты окружения сеанса: токен шага, который дорога кладёт в окружение CLI, значения пина
 * под секретным именем и ключи маршрута, которые дорога прочитала для сеанса (`routeKeys`,
 * книга `session-keys.ts`) — под любым именем: `LLAMA_ACCESS` секретом по имени не выглядит.
 */
export function sessionKnown(
  tokens: Pick<SessionTokens, 'mint'>,
  pin: Record<string, string>,
  taskId: string,
  sessionId: string,
  routeKeys: readonly string[] = [],
): string[] {
  const out = new Set<string>();
  try {
    out.add(tokens.mint({ taskId, sessionId }));
  } catch {
    // Не UUIDv7 (псевдозадача) — токена сеанса у неё нет.
  }
  for (const [name, value] of Object.entries(pin))
    if (isSecretName(name) && value.length >= MIN_KNOWN) out.add(value);
  for (const value of routeKeys) if (value.length >= MIN_KNOWN) out.add(value);
  return [...out];
}

/** Числа файла диффа из его тела: строк `+`/`-` без заголовков, двоичный — по пометке git. */
function packFileOf(path: string, body: Fact<string>): PackFile {
  if (!('value' in body)) return { path, added: 0, deleted: 0, binary: false, diff: null };
  let added = 0;
  let deleted = 0;
  for (const line of body.value.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deleted += 1;
  }
  const binary = /^Binary files /m.test(body.value);
  return { path, added, deleted, binary, diff: binary ? null : body.value };
}

/**
 * Вход пакета ревью единицы: дифф копии от закреплённой при создании базы (sha, не имя ветки —
 * ушедшая вперёд ветка подмешала бы ревьюеру чужие коммиты), требования и записи из свёртки.
 */
export async function unitReviewInput(
  task: LiveTask,
  unitId: string,
): Promise<Omit<ReviewPackInput, 'known'> | null> {
  const copy = unitCopyOf(task, unitId);
  // Ревью MR по ссылке — от общего предка с целевой веткой (этап 10, F8), остальное — приколотая база.
  const base = reviewBaseOf(task, unitId);
  if (!copy || !base) return null;
  const changed = await diffUnit(copy.dir, base);
  if (!('value' in changed)) return null;
  const files = await Promise.all(
    changed.value.map(async (path) => packFileOf(path, await diffFileOf(copy.dir, base, path))),
  );
  return { unitId, baseRef: base, files, ...reviewInputsOf(task.state, unitId) };
}

export function bootEconomy(deps: BootEconomyDeps): BootEconomy {
  const now = deps.now ?? Date.now;
  let learned: LearnedTable | null = null;
  const history = async (): Promise<LearnedTable | null> => {
    const got = await readLearned({
      tasksDir: deps.tasksDir,
      cacheFile: learnedCachePath(dirname(deps.tasksDir)),
    });
    learned = 'value' in got ? got.value : null;
    return learned;
  };
  const known = (taskId: string, sessionId: string): readonly string[] => {
    const pin = deps.pin();
    const routeKeys = deps.keys?.valuesOf(sessionId, pin) ?? [];
    return sessionKnown(deps.sessionTokens, pin, taskId, sessionId, routeKeys);
  };
  // Первое чтение — в фоне: бюджет токенов до него судит по приору, как без истории.
  void history().catch(() => undefined);
  const ladders = laddersOf(deps.adapters);
  const run = createRunEconomy({
    ladders,
    windows: deps.windows,
    now,
    ...(deps.contour ? { contour: deps.contour } : {}),
    context: deps.context,
    known,
    reviewPack: unitReviewInput,
    learned: () => learned,
    resumes: (adapter) => deps.adapters.get(adapter)?.caps.resume === true,
    transcriptPresent: (adapter, conversationId, where) =>
      deps.adapters
        .get(adapter)
        ?.transcriptPresent?.(
          deps.pin(),
          conversationId,
          journaledSessionDir(where.task, where.sessionId),
        ),
    ...(deps.windowOf ? { windowOf: deps.windowOf } : {}),
  });
  return { run, known, history, learned: () => learned, ladders };
}
