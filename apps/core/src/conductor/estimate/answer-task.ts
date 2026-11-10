import type { EstimateBody } from '@agentdeck/contracts/core/estimate';
import { publicationOf } from '../../journal/reduce/publish.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { commitOf, type CopyGitOptions } from '../../platform/copy-git.ts';
import type { TaskRegistry } from '../tasks.ts';
import type { AnswerTaskInput, AnswerTaskOutcome } from './answer-task.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import { boardStopOf } from '../../journal/reduce/fold-view.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { ANSWER_REVIEWERS_PRESET, createTask, refuse, replayEstimate } from './estimate.ts';
import type { CreateSeed, PinnedRepoView, SplitEnv } from './estimate.types.ts';

/**
 * Новая задача ответов ревьюерам по поздним заметкам в MR законченной задачи (05:77-78, 01:61).
 * Тот же путь создания, что у оценки (`createTask`), с тремя отличиями:
 * - база — ветка MR НА СЕРВЕРЕ (`<remote>/<ветка MR>` после fetch), приколотый sha = голова MR:
 *   публикатор собирает только коммиты поверх неё и никогда не переписывает запушенное;
 * - ветка единицы 0 — ветка MR как её вернул форж (F11), MR тот же: `publish.mr` задачи-источника
 *   переходит в журнал новой под ключом её единицы (P31 — личность MR от форжа, не догадка);
 * - строки `forge.event` опроса — причина задачи, сразу за её созданием.
 * Запуск — человеком (`confirm`), CI не ждём (R:S1-09: ждать — только живое решение человека);
 * этап 12: источник «до конца» с доски и доработка человеком — `auto` (`launchOf`).
 * Локальная ветка MR стоит не там, где голова на сервере — отказ с причиной: публиковать со
 * старой ветки значит потерять чужие коммиты или затереть их пушем.
 */

const PRESET = ANSWER_REVIEWERS_PRESET;

function sourceState(registry: TaskRegistry, taskId: string) {
  try {
    return registry.live(taskId)?.state ?? registry.view(taskId);
  } catch {
    return undefined;
  }
}

/** Текст запроса: какой MR, чьи заметки; разбор читает нити сам (бриф шага ответа их несёт). */
export function answerRequestOf(
  input: AnswerTaskInput,
  mr: { url: string; sourceBranch: string },
  title: string,
): string {
  const authors = [...new Set(input.events.map((e) => e.author).filter(Boolean))];
  const note = input.note?.trim();
  return [
    `Ответить ревьюерам в MR ${mr.url} (!${input.mrIid}, ветка ${mr.sourceBranch}) — «${title}».`,
    `Новые заметки: ${authors.length > 0 ? authors.join(', ') : 'автор не назван'} (${input.events.length}).`,
    ...input.events.map((e) => `- ${e.type} ${e.forgeEventId}${e.author ? ` от ${e.author}` : ''}`),
    // Доработка (P162): слово человека — часть запроса, иначе бриф носителя его не увидит.
    ...(note ? ['Доработка от человека:', note] : []),
    'Прочитать открытые нити MR и ответить на каждую; правка кода — новыми коммитами в ту же ветку.',
  ].join('\n');
}

type TaskBoardEntry = NonNullable<JournalDataV1['task.created']['boardEntry']>;

/**
 * Остановка источника решает запуск носителя (P157, D7): «до конца» с доски — `auto` и тот же
 * `boardEntry` (доказательство старта — ход человека над источником); иначе — `confirm`, без
 * факта доски. Доработка (`cmdId` назван) — тоже `auto`: человек уже сказал, что делать.
 */
function launchOf(
  source: TaskFoldState,
  rework: boolean,
): { launchPolicy: 'auto' | 'confirm'; boardEntry?: TaskBoardEntry } {
  const entry = source.created?.boardEntry;
  const end = boardStopOf(source) === 'end' && entry !== undefined;
  return {
    launchPolicy: end || rework ? 'auto' : 'confirm',
    ...(entry && (end || rework) ? { boardEntry: entry } : {}),
  };
}

/** Создания в полёте по `cmdId`: двойной клик ждёт первое, а не создаёт второй носитель. */
const inflight = new Map<string, Promise<AnswerTaskOutcome>>();

export const HALF_MADE_ANSWER_REASON =
  'answer task left half-made by a core crash (no unit 0): ended so the forge poller reopens it';

/**
 * Загрузка: задача ответов без единицы 0 — недоделанная крахом между созданием задачи и единицы
 * (в процессе создание идёт без перерыва, переживает его только крах). Не кончи её — она держит
 * MR вечно (`watched`, `held`); `failed` отпускает MR, и её заметки опрос откроет заново.
 * Ответ — id кончённых.
 */
export function failHalfMadeAnswers(registry: TaskRegistry, taskIds: readonly string[]): string[] {
  const ended: string[] = [];
  for (const taskId of taskIds) {
    const task = registry.live(taskId);
    if (!task || task.state.ended !== null) continue;
    if (task.state.created?.scenario.id !== PRESET) continue;
    if (Object.keys(task.state.units).length > 0) continue;
    refuse(task, [HALF_MADE_ANSWER_REASON], newId());
    ended.push(taskId);
  }
  return ended;
}

export async function openAnswerTask(
  input: AnswerTaskInput,
  registry: TaskRegistry,
  env: SplitEnv,
  git: CopyGitOptions = {},
): Promise<AnswerTaskOutcome> {
  const key = input.cmdId;
  if (key === undefined) return createAnswerTask(input, newId(), registry, env, git);
  const running = inflight.get(key);
  if (running) await running.catch(() => undefined);
  const replayed = replayEstimate(registry, key);
  if (replayed) return { opened: replayed.taskId, reply: replayed };
  const work = createAnswerTask(input, key, registry, env, git);
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

async function createAnswerTask(
  input: AnswerTaskInput,
  cmdId: string,
  registry: TaskRegistry,
  env: SplitEnv,
  git: CopyGitOptions,
): Promise<AnswerTaskOutcome> {
  const source = sourceState(registry, input.fromTaskId);
  if (!source) return { refused: [`task ${input.fromTaskId}: journal unreadable`] };
  const mr = publicationOf(source, input.unitId).mr;
  if (!mr) return { refused: [`task ${input.fromTaskId} unit ${input.unitId}: no MR identity`] };
  if (mr.mrIid !== input.mrIid)
    return {
      refused: [`task ${input.fromTaskId}: MR !${mr.mrIid} journaled, !${input.mrIid} asked`],
    };
  const branch = mr.sourceBranch;
  const title = source.created?.title ?? 'Ответы ревьюерам';
  const launch = launchOf(source, input.cmdId !== undefined);
  const body: EstimateBody = {
    cmdId,
    proof: {},
    fields: {
      title,
      request: answerRequestOf(input, mr, title),
      repos: [{ path: input.repo, baseRef: `${input.remote}/${branch}` }],
      scenario: { preset: PRESET },
      launchPolicy: launch.launchPolicy,
      ciWait: false,
    },
  };
  return createAnswer(body, registry, env, {
    checkPinned: mrHeadCheck(branch, git),
    branch,
    refuseBeforeCreate: true,
    ...(launch.boardEntry ? { created: () => ({ boardEntry: launch.boardEntry! }) } : {}),
    opened(task, cmdId) {
      for (const e of input.events)
        task.append({ kind: 'forge.event', actor: 'core', cmdId, data: { ...e } });
    },
    afterUnitZero(task, zero, cmdId) {
      const { seq: _seq, ...identity } = mr;
      task.append({
        kind: 'publish.mr',
        actor: 'core',
        unitId: zero.unitId,
        cmdId,
        data: { ...identity, unitId: zero.unitId },
      });
    },
  });
}

/**
 * Предпроверка базы задачи ответов: голова MR — только свежая с сервера (локальная
 * `<remote>/<ветка>` могла отстать от чужих пушей), локальная ветка MR — там же, где голова.
 */
export function mrHeadCheck(
  branch: string,
  git: CopyGitOptions,
): (pinned: readonly PinnedRepoView[]) => Promise<string[]> {
  return async (pinned) => {
    const p = pinned[0];
    if (!p) return ['no repository pinned'];
    if (p.pin.source !== 'fresh')
      return [`${branch}: the MR head on the server was not read (${p.pin.note ?? 'no fetch'})`];
    const local = await commitOf(p.path, `refs/heads/${branch}`, git);
    if ('unknown' in local) return [`${branch}: local branch unreadable: ${local.unknown}`];
    if ('value' in local && local.value !== p.sha)
      return [
        `${branch}: the local branch is at ${local.value.slice(0, 12)}, the MR head on the server at ${p.sha.slice(0, 12)} — update or remove the local branch`,
      ];
    return [];
  };
}

/**
 * Создание задачи ответов общей дорогой оценки. Сбой посреди создания: недоделанная задача
 * (причина уже в журнале) кончается `failed` — её заметки не съедены, следующий круг откроет
 * задачу заново. Крах процесса сюда не доходит: тогда недоделанная задача не кончена и держит MR
 * (`watched`). Отказ сценария и упавшая предпроверка — 422 до создания (`refuseBeforeCreate`):
 * задачи нет, следующий круг повторит её, когда причину уберут.
 */
export async function createAnswer(
  body: EstimateBody,
  registry: TaskRegistry,
  env: SplitEnv,
  seed: CreateSeed,
): Promise<AnswerTaskOutcome> {
  let made: LiveTask | undefined;
  const opened = seed.opened;
  const tracked: CreateSeed = {
    ...seed,
    opened(task, cmdId) {
      made = task;
      opened?.(task, cmdId);
    },
  };
  let got: Awaited<ReturnType<typeof createTask>>;
  try {
    got = await createTask(body, registry, env, tracked);
  } catch (error) {
    const why = `answer task creation failed: ${error instanceof Error ? error.message : String(error)}`;
    if (made && made.state.ended === null) refuse(made, [why], body.cmdId);
    return { refused: [why] };
  }
  if (got.status === 422) return { refused: got.problems };
  return { opened: got.reply.taskId, reply: got.reply };
}
