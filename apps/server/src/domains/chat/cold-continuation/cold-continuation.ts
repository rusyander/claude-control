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
import { COLD_RESUME_INTRO, coldResumeBrief } from '../split-continue.ts';

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
  now: number;
}

export type Continuation =
  { kind: 'resume' } | { kind: 'fresh'; brief: string; previous: string; contextTokens: number };

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
export function coldResumeNotice(previous: string, contextTokens: number): ChatEvent {
  const params = { tokens: String(Math.round(contextTokens / 1000)), previous };
  return {
    kind: 'notice',
    code: 'coldResume',
    text: serverText('chat-cold-resume-notice', params),
    textCode: 'chat-cold-resume-notice',
    textParams: params,
  };
}

/** Вводная с заданием стадии вслед за общими строками. */
export function withStageTask(intro: string, task: string): string {
  return `${intro}\n${STAGE_TASK_LINE}\n\n${task}`;
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
