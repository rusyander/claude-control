import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { LeadSection } from '@agentdeck/contracts/core/lead';
import { toolPlanFor } from '@agentdeck/contracts/core/model-tools';
import type { BriefPart } from '../../context/brief/index.ts';
import { tokensOf } from '../../context/base/index.ts';
import type { ReviewPackInput } from '../../context/review-pack/index.ts';
import type { ContextWiring } from './context.ts';
import type { RunEconomy } from '../../conductor/run/run.types.ts';
import type { RoutingEnv } from '../../conductor/scenario/index.ts';
import type { ContinuationFacts, ContinuationSession } from '../../economy/continuation.types.ts';
import { ECON_PRIOR } from '../../economy/econ/prior.ts';
import { decideKeepWarm } from '../../economy/keep-warm/index.ts';
import { kindKeyOf, type LearnedTable } from '../../economy/learned/index.ts';
import { LEARNED_BUDGET_FACTOR } from '../../economy/budget/index.ts';
import { sessionCacheFacts } from '../../economy/session-facts.ts';
import type { TierLadder } from '../../economy/tier.types.ts';
import type { WindowBook } from '../../economy/window/index.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { allowedRoutesOf } from '../../journal/reduce/fold-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { ContourPolicy } from '../../policy/resolve/resolve.types.ts';
import { routingFacts, type RoutingFactsDeps } from './routing-facts.ts';

/**
 * Порт экономики исполнителя (этап 5, W): судьи у владельцев — окно (L, `WindowBook`), модель,
 * продолжение, бюджет и прогрев (E), бриф и дельта (C); здесь только сбор их входа из журнала
 * задачи и книги окон. Исполнитель (`conductor/run`) знает лишь `RunEconomy`.
 */

export interface RunEconomyDeps {
  /** Книга окон ядра — одна на процесс (её же читают судьи и `/v1/health`). */
  windows: WindowBook;
  now: () => number;
  /**
   * Активный контур панели (уровень 1) — вход суда `tier` каждого шага, читается на каждый шаг
   * (s10 G7); нет или `undefined` — без контура.
   */
  contour?: () => ContourPolicy | undefined;
  /** Проводка контекста (C): бриф, дельта, отказ брифа сверх бюджета. Нет — бриф этапа 4. */
  context?: ContextWiring;
  /** Значения секретов окружения сессии — бриф и пакет ревью их маскируют (C: `known`, P61). */
  known?(taskId: string, sessionId: string): readonly string[];
  /**
   * Вход пакета ревью единицы (дифф от закреплённой базы, требования, записи); `null` — собрать
   * нечем (копии нет). Без него шаг ревью получает только бриф.
   */
  reviewPack?(task: LiveTask, unitId: string): Promise<Omit<ReviewPackInput, 'known'> | null>;
  /** Выученное (E, `readLearned`) — последнее прочитанное; `null` — истории нет. */
  learned?(): LearnedTable | null;
  /** Переходник объявил продолжение сеанса (`caps.resume`): без него ни продолжения, ни прогрева. */
  resumes?(adapter: string): boolean;
  /**
   * Транскрипт разговора кончившейся сессии на месте (корень `conversationOf`, переходник сессии);
   * `undefined` — неизвестно: судья не форсирует новый сеанс и не продолжает кончившийся.
   */
  transcriptPresent?(
    adapter: string,
    conversationId: string,
    /** Задача и сессия кандидата: переходник со своим домом у сеанса ищет транскрипт в её каталоге. */
    where: { task: LiveTask; sessionId: string },
  ): boolean | undefined;
  /**
   * Лестницы переходников загрузки (`laddersOf`) — вход суда `tier` каждого шага. Нет — уровень
   * сценария не понижает и не поднимает, пол ревьюера сравнивает только имена.
   */
  ladders?: Readonly<Record<string, TierLadder>>;
  /**
   * Окно контекста маршрута × модели (`bootstrap/route-windows.ts`, одна книга с наблюдателем);
   * нет — окно, названное сессией в `turn.usage`; нет и его — правило 60 % продолжения не судит.
   */
  windowOf?(routeId: string, model: string | null): number | null;
  /**
   * Факты шага суда `tier` (этап 11, `routing-facts.ts`): раздел ведущего, политика машины, подъём
   * по обучению. Нет — роль, эскалация и автор всё равно из журнала, строки роли без правок.
   */
  facts?: RoutingFactsDeps;
  recheckMs?: number;
  keepWarmTickMs?: number;
}

/** Сессия ещё идёт: её разговор у процесса, файл транскрипта не спрашивается. */
const OPEN_STATES: ReadonlySet<string> = new Set(['starting', 'live', 'quiet']);

const linesOf = (task: LiveTask): JournalLine[] => readJournalLines(task.dir, task.taskId).lines;

/**
 * Разговор модели = корень цепочки `resumeOf`: продолжение (`--resume`) — новая сессия ядра, но
 * та же история у модели, и набор отданного (`sent`, P13) ведётся по корню — иначе дельта
 * возобновлённой сессии повторила бы весь бриф.
 */
export function conversationOf(lines: readonly JournalLine[], sessionId: string): string {
  const parent = new Map<string, string>();
  for (const l of lines) {
    if (l.kind !== 'session.started') continue;
    const d = (l as JournalLine<'session.started'>).data;
    if (d.resumeOf) parent.set(d.sessionId, d.resumeOf);
  }
  let at = sessionId;
  const seen = new Set<string>();
  while (parent.has(at) && !seen.has(at)) {
    seen.add(at);
    at = parent.get(at) as string;
  }
  return at;
}

/** Числа продолжения (03:150-155) для сессии-кандидата: ходы, кэш, база, бриф, выученное. */
export function continuationFacts(
  task: LiveTask,
  lines: readonly JournalLine[],
  candidate: ContinuationSession,
  now: number,
  windowOf?: (routeId: string, model: string | null) => number | null,
): ContinuationFacts {
  const cache = sessionCacheFacts(lines, candidate.sessionId);
  // Маршрут и модель — последнего хода основной сессии (как у роста контекста наблюдателя).
  let served: { routeId: string; model: string; reported: number | null } | null = null;
  for (const l of lines) {
    if (l.kind !== 'turn.usage') continue;
    const u = (l as JournalLine<'turn.usage'>).data;
    if (u.sessionId === candidate.sessionId && !u.subagent && !u.remainder)
      served = { routeId: u.routeId, model: u.model, reported: u.contextWindow ?? null };
  }
  const base = [...task.state.bases].reverse().find((b) => b.adapter === candidate.adapter);
  const root = conversationOf(lines, candidate.sessionId);
  let briefBytes = 0;
  for (const l of lines) {
    if (l.kind !== 'brief.sent') continue;
    const d = (l as JournalLine<'brief.sent'>).data;
    if (d.sessionId === root || d.sessionId === candidate.sessionId)
      for (const s of d.sections) briefBytes += s.bytes;
  }
  const baseTokens = base?.tokens ?? 0;
  return {
    now,
    lastTurnAt: cache.lastTurnAt,
    contextTokens: cache.contextTokens,
    cacheTtlMs: cache.cacheTtlMs,
    // Окно модели — факт `context` маршрута из той же книги, что у наблюдателя; нет его — окно,
    // названное сессией (`turn.usage.contextWindow`, как у роста контекста); нет и его — не судит.
    windowTokens: served ? (windowOf?.(served.routeId, served.model) ?? served.reported) : null,
    baseTokens,
    briefTokens: tokensOf(briefBytes),
    // Ходов впереди — хотя бы следующий; выученных ходов шага журналы ещё не дают.
    expectedTurns: 1,
    orientationTurns: ECON_PRIOR.orientationTurns,
    turnCost: ECON_PRIOR.turnCostRatio * baseTokens,
  };
}

export function createRunEconomy(deps: RunEconomyDeps): RunEconomy {
  const pings = new Map<string, { wait: string; count: number; lastPingAt: number | null }>();

  const routingEnv = (task: LiveTask): RoutingEnv => {
    const now = deps.now();
    // Набор сейчас — `routes.set` команды поверх `task.created` (`allowedRoutesOf`).
    const routes = [...new Set(allowedRoutesOf(task.state).map((r) => r.route.id))];
    let lines: JournalLine[] | null = null;
    const contour = deps.contour?.();
    // Раздел ведущего читается с диска один раз на проход суда (как строки журнала выше): строка
    // роли и порог подъёма каждого шага прохода судят по одному чтению настройки ядра.
    let section: { value: LeadSection | undefined } | null = null;
    const facts = deps.facts && {
      ...deps.facts,
      leadSection: () => (section ??= { value: deps.facts?.leadSection?.() }).value,
    };
    return {
      windows: routes.flatMap((id) => deps.windows.decide(id, now)),
      ...(contour ? { contour } : {}),
      ...(deps.ladders ? { tier: { ladders: deps.ladders } } : {}),
      step: (state, step) => routingFacts(state, (lines ??= linesOf(task)), step, facts),
      continuation: (candidate) => {
        const read = (lines ??= linesOf(task));
        const present = transcriptOf(task, candidate, read);
        return {
          facts: continuationFacts(task, read, candidate, now, deps.windowOf),
          ...(present === undefined ? {} : { transcriptPresent: present }),
        };
      },
    };
  };

  /**
   * Транскрипт кандидата: переходник без продолжения — продолжать нечем; живая сессия держит
   * разговор сама (не спрашивается); у кончившейся — файл по корню разговора (`--resume`).
   */
  const transcriptOf = (
    task: LiveTask,
    candidate: ContinuationSession,
    lines: readonly JournalLine[],
  ): boolean | undefined => {
    if (deps.resumes && !deps.resumes(candidate.adapter)) return false;
    if (OPEN_STATES.has(candidate.state)) return undefined;
    return deps.transcriptPresent?.(candidate.adapter, conversationOf(lines, candidate.sessionId), {
      task,
      sessionId: candidate.sessionId,
    });
  };

  /** Пакет ревью единицы в ту же сессию (C `pack`): только изменённые его секции. */
  const packOf = async (
    task: LiveTask,
    unitId: string,
    conv: string,
    known: readonly string[],
  ): Promise<string | null> => {
    if (!deps.context || !deps.reviewPack) return null;
    const input = await deps.reviewPack(task, unitId);
    if (!input) return null;
    return deps.context.pack(task, conv, { ...input, known })?.text ?? null;
  };

  return {
    windows: (routeId) => deps.windows.decide(routeId, deps.now()),
    routingEnv,
    ...(deps.context
      ? {
          briefRefusal: (_task, s, sections) =>
            (deps.context as ContextWiring).refusal(sections as readonly BriefPart[], s.def.kind),
          opening: async (task, s, sessionId, sections) => {
            const conv = conversationOf(linesOf(task), sessionId);
            const known = deps.known?.(task.taskId, sessionId) ?? [];
            const brief =
              (deps.context as ContextWiring).opening(
                task,
                conv,
                sections as readonly BriefPart[],
                s.def.kind,
                known,
              )?.text ?? null;
            // Шаг, судящий сделанную правку (у него `unit_diff`), получает пакет единицы
            // (03 §Context) — после брифа, тем же словом; сверх предела пакет зовёт `unit_diff`.
            const pack = toolPlanFor(s.def.kind)?.modelTools.includes('unit_diff')
              ? await packOf(task, s.unitId, conv, known)
              : null;
            const text = brief === null || pack === null ? (brief ?? pack) : `${brief}\n\n${pack}`;
            // Вторая половина ожидания первого хода (дрейф G9): база + ровно это слово.
            if (text !== null)
              (deps.context as ContextWiring).sent(sessionId, Buffer.byteLength(text, 'utf8'));
            return text;
          },
        }
      : {}),
    ...(deps.learned
      ? {
          learnedTokens: (task, step) => {
            const table = deps.learned?.();
            const project = task.state.units[step.unitId]?.repoKey;
            if (!table || !project) return undefined;
            const stats = table.byKind[kindKeyOf({ project, stepKind: step.kind })];
            if (!stats || stats.runs === 0 || stats.p90Tokens <= 0) return undefined;
            return Math.round(stats.p90Tokens * LEARNED_BUDGET_FACTOR);
          },
        }
      : {}),
    keepWarm: (task, idle) => {
      if (idle.length === 0) return [];
      const lines = linesOf(task);
      const now = deps.now();
      const out: ReturnType<NonNullable<RunEconomy['keepWarm']>> = [];
      for (const s of idle) {
        const rec = task.state.sessions[s.sessionId];
        if (!rec) continue;
        const wait = `${s.sessionId}:${s.turnSeq}`;
        const prior = pings.get(s.sessionId);
        const counted = prior && prior.wait === wait ? prior : { wait, count: 0, lastPingAt: null };
        const cache = sessionCacheFacts(lines, s.sessionId);
        const window = deps.windows.decide(rec.route.id, now)[0]?.verdict ?? null;
        const d = decideKeepWarm({
          now,
          session: {
            parked: s.parked,
            lastTurnAt: cache.lastTurnAt,
            contextTokens: cache.contextTokens,
            cacheTtlMs: cache.cacheTtlMs,
          },
          adapterResume: deps.resumes?.(rec.adapter) ?? false,
          // Книга без фактов маршрута — «открыто по умолчанию» здесь не выдумывается: `null`.
          window: window ?? (deps.windows.routes().includes(rec.route.id) ? 'open' : null),
          pings: { count: counted.count, lastPingAt: counted.lastPingAt },
        });
        if (d.kind !== 'ping') {
          pings.set(s.sessionId, counted);
          continue;
        }
        pings.set(s.sessionId, { wait, count: counted.count + 1, lastPingAt: now });
        out.push({ sessionId: s.sessionId, word: d.word, reasons: d.reasons, numbers: d.numbers });
      }
      return out;
    },
    ...(deps.recheckMs === undefined ? {} : { recheckMs: deps.recheckMs }),
    ...(deps.keepWarmTickMs === undefined ? {} : { keepWarmTickMs: deps.keepWarmTickMs }),
  };
}
