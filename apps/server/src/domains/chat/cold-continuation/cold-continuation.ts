import { statSync } from 'node:fs';
import type { GroupEconomy } from '@agentdeck/contracts/group-economy';
import { continuationEnvironment } from '@agentdeck/contracts/task-split';
import type { ChatLink, SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import type { ChatEvent } from '../chat-events.ts';
import {
  findTranscript,
  readHeadRecords,
  readTailRecords,
} from '../ChatTranscriptFile/ChatTranscriptFile.ts';
import { toUsage, type Record as TranscriptRecord } from '../ChatRecords/ChatRecords.ts';
import { coldResume } from '../group-continuation/group-continuation.ts';
import { coldBriefFacts } from '../cold-brief/cold-brief.ts';
import {
  COLD_RESUME_INTRO,
  GROUP_TASKS_HEADER,
  RELAY_FRESH_INTRO,
  coldResumeBrief,
} from '../split-continue.ts';

/**
 * Решение «продолжить сессию или начать новую» для каждого продолжения группы
 * (F-05 ревью П1, директива §L4). Раньше правило жило только в запуске стадий
 * (`review-starter`), а повтор после лимита, «Продолжить всё», ответ человека и
 * отложенный старт продолжали остывшую сессию и переписывали всё окно в кэш.
 * Теперь одна функция решает везде: запуск стадий спрашивает её сам, реестр
 * прогонов — на старте каждого продолжения группы.
 */

/** Хвоста в полмегабайта хватает на последний ответ модели даже за большим выводом. */
const WARMTH_TAIL_BYTES = 512 * 1024;

/**
 * Строка перед заданием стадии в вводной: новая сессия иначе не знала бы ни MR,
 * ни что проверять, ни что делать (F-01 ревью П1).
 */
export const STAGE_TASK_LINE =
  'The original task of this stage follows; the request after it continues that task.';

/** Окно вызова модели по записи транскрипта; не вызов — undefined. */
function callContext(record: TranscriptRecord): number | undefined {
  const usage = toUsage(record);
  return usage ? usage.input + usage.cacheRead + usage.cacheCreation : undefined;
}

/**
 * Сколько сессия стоит, какое окно у её последнего вызова (хвост транскрипта)
 * и какое у первого (голова) — база, с которой начал бы новый разговор.
 */
export function sessionWarmth(
  dir: string,
  sessionId: string,
  now: number,
): { file: string; idleMs: number; contextTokens: number; freshBase: number } | undefined {
  const file = findTranscript(dir, sessionId);
  if (!file) return undefined;
  const tail = readTailRecords(file, WARMTH_TAIL_BYTES);
  let contextTokens = 0;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const context = callContext(tail[index]!);
    if (context === undefined) continue;
    contextTokens = context;
    break;
  }
  let freshBase = 0;
  for (const record of readHeadRecords(file)) {
    const context = callContext(record);
    if (context === undefined) continue;
    freshBase = context;
    break;
  }
  return { file, idleMs: now - statSync(file).mtimeMs, contextTokens, freshBase };
}

export interface ContinuationInput {
  /** Каталог транскриптов CLI (`projects`). */
  dir: string;
  /** Сессия, которую просят продолжить. */
  sessionId: string;
  /** Копия группы: из неё вводная берёт заметки и git. */
  cwd: string;
  economy: Pick<GroupEconomy, 'freshOnColdResume' | 'cacheTtl'> | undefined;
  /** Первые строки вводной — задачи группы, задание стадии; нет — общая строка. */
  intro?: string;
  /** Ветка, от которой отведена копия группы (`base`): от неё вводная считает коммиты. */
  base?: string;
  /**
   * Продолжение после сброса лимита (директива §L8): кэш считается остывшим при
   * любом простое, решает только окно.
   */
  afterLimit?: boolean;
  /**
   * Последний пинг тёплого кэша сессии (`keep-warm`), мс эпохи. Пинг идёт без
   * транскрипта, и время файла о нём не знает: без этой отметки согретая сессия
   * считалась бы остывшей и уходила в новый разговор — пинг был бы зря.
   */
  warmedAt?: number;
  /**
   * Слово доставленной группе (N4): решает только окно — выше
   * `RELAY_FRESH_ABOVE_TOKENS` новый разговор и при тёплом кэше.
   */
  relay?: boolean;
  now: number;
}

export type Continuation =
  | { kind: 'resume' }
  | {
      kind: 'fresh';
      brief: string;
      previous: string;
      contextTokens: number;
      /** Почему новый: остывший кэш или слово доставленной группе (N4). */
      reason?: 'relay';
    };

/**
 * Окно, выше которого слово доставленной группе идёт новым разговором (N4, g5
 * 25.10): ход по красному конвейеру вёз 146k → 168k окна доставки в каждом из 24
 * запросов, а вводная с фактами копии — единицы тысяч.
 */
export const RELAY_FRESH_ABOVE_TOKENS = 60_000;

/**
 * Продолжить ли сессию. Новая — когда рычаг `freshOnColdResume` включён, кэш
 * остыл (или был лимит) и окно выше базы + 25k (`coldResume`). Вводную собирает
 * панель из файлов: остывшую сессию не просят пересказать себя — это то самое
 * холодное чтение всего окна, которого избегаем.
 */
export function decideContinuation(input: ContinuationInput): Continuation {
  if (!input.economy?.freshOnColdResume) return { kind: 'resume' };
  const warmth = sessionWarmth(input.dir, input.sessionId, input.now);
  if (!warmth) return { kind: 'resume' };
  // Пинг после последней записи сессии — кэш свежее файла; и ожидание лимита
  // тогда не значит «остыл при любом простое»: его грели всё ожидание.
  const warmedIdle = input.warmedAt !== undefined ? input.now - input.warmedAt : undefined;
  const warmed = warmedIdle !== undefined && warmedIdle < warmth.idleMs;
  const idleMs = warmed ? warmedIdle : warmth.idleMs;
  if (input.relay && warmth.contextTokens > RELAY_FRESH_ABOVE_TOKENS) {
    return {
      kind: 'fresh',
      brief: `${input.intro ?? RELAY_FRESH_INTRO}\n\n${coldBriefFacts(input.cwd, warmth.file, input.base)}`,
      previous: input.sessionId,
      contextTokens: warmth.contextTokens,
      reason: 'relay',
    };
  }
  const cold = coldResume({
    idleMs: input.afterLimit && !warmed ? Number.POSITIVE_INFINITY : idleMs,
    contextTokens: warmth.contextTokens,
    freshBase: warmth.freshBase,
    ...(input.economy.cacheTtl ? { cacheTtl: input.economy.cacheTtl } : {}),
  });
  if (!cold) return { kind: 'resume' };
  return {
    kind: 'fresh',
    brief: `${input.intro ?? COLD_RESUME_INTRO}\n\n${coldBriefFacts(input.cwd, warmth.file, input.base)}`,
    previous: input.sessionId,
    contextTokens: warmth.contextTokens,
  };
}

/** Заметка человеку в чат группы: остывший разговор не продолжен, ход пошёл новым. */
export function coldResumeNotice(
  previous: string,
  contextTokens: number,
  reason?: 'relay',
): ChatEvent {
  const params = { tokens: String(Math.round(contextTokens / 1000)), previous };
  const textCode = reason === 'relay' ? 'chat-mr-relay-fresh-notice' : 'chat-cold-resume-notice';
  return {
    kind: 'notice',
    code: 'coldResume',
    text: serverText(textCode, params),
    textCode,
    textParams: params,
  };
}

/**
 * Задачи группы, которые задание стадии уже называет дословно, вводная не
 * повторяет: g0 25.10 нёс список из семи задач дважды — 1,8k знаков на вводную.
 */
function dropListedTasks(intro: string, task: string): string {
  const lines = intro.split('\n');
  const header = lines.indexOf(GROUP_TASKS_HEADER);
  if (header < 0) return intro;
  let end = header + 1;
  while (end < lines.length && lines[end]!.startsWith('- ')) end += 1;
  const left = lines.slice(header + 1, end).filter((line) => !task.includes(line.slice(2)));
  const list = left.length > 0 ? [GROUP_TASKS_HEADER, ...left] : [];
  return [...lines.slice(0, header), ...list, ...lines.slice(end)].join('\n');
}

/**
 * Вводная слова доставленной группе (N4): ветка, MR и задачи — без задания
 * стадии. Задание доставки (52k у g5) слову наблюдателя не нужно: оно само
 * называет MR, конвейер или ветки ревьюера.
 */
export function relayIntro(link: ChatLink, plan: SplitPlanRecord | undefined): string {
  const group = plan?.groups.find((item) => item.index === link.groupIndex);
  return plan && group
    ? coldResumeBrief(group, plan.proposal.groups[group.index]?.tasks ?? [], RELAY_FRESH_INTRO)
    : RELAY_FRESH_INTRO;
}

/** Вводная с заданием стадии вслед за общими строками. */
export function withStageTask(intro: string, task: string): string {
  return `${dropListedTasks(intro, task)}\n${STAGE_TASK_LINE}\n\n${task}`;
}

/**
 * Первые строки вводной по связи разговора: ветка и задачи группы из плана,
 * затем задание стадии — непорождённого звена (`stagePrompt`) или группы
 * (`task`). Продолжения вроде «повтори упавший ход» или «продолжи после паузы»
 * сами задания не несут, и новая сессия без него не знала бы, что делать.
 */
export function continuationIntro(link: ChatLink, plan: SplitPlanRecord | undefined): string {
  const group =
    plan &&
    (plan.groups.find((item) => item.index === link.groupIndex) ??
      plan.groups.find((item) => link.branch && item.branch === link.branch));
  const head = group
    ? coldResumeBrief(group, plan.proposal.groups[group.index]?.tasks ?? [])
    : COLD_RESUME_INTRO;
  const task = link.stagePrompt ?? link.task;
  // Окружение к продолжению давно готово: преамбула — сжатая, как в передаче стадии.
  return task ? withStageTask(head, continuationEnvironment(task)) : head;
}
