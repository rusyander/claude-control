import type { GroupEconomy } from '@agentdeck/contracts/group-economy';
import type { ChatTreeAsk } from '@agentdeck/contracts/chat-handoff';
import type { SplitPlanGroupRecord, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunMeta } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.types.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import type { WarmOutcome } from '../../domains/chat/ChatRunRegistry/warm-ping.ts';
import { findTranscript } from '../../domains/chat/ChatTranscriptFile/ChatTranscriptFile.ts';
import { readLimitRuns } from '../../domains/chat/limit-journal/limit-journal.ts';
import { heavyQueueWait } from '../../domains/group-progress/heavy-wait.ts';
import {
  addPing,
  decideKeepWarm,
  firstCallAfter,
  KEEP_WARM_PROMPT,
  keepWarmGroupKey,
  keepWarmPath,
  keepWarmTemplate,
  pingCost,
  pingVerdict,
  rateLimitedNow,
  readKeepWarm,
  sessionCallTail,
  settleGroup,
  settleWait,
  templateOptions,
  writeKeepWarm,
} from '../../domains/chat/keep-warm/keep-warm.ts';
import type {
  KeepWarmFile,
  KeepWarmSessionState,
  KeepWarmWait,
} from '../../domains/chat/keep-warm/keep-warm.types.ts';

/**
 * Проводка пинга тёплого кэша (`keep-warm`): раз в минуту — ждущие группы всех
 * разделений → решение домена → пинг через реестр прогонов → учёт: счёт пингов
 * ожидания, попадание или промах, отметка «согрето» решению о продолжении и
 * сторожу, расход и сбережённое в счёт группы. Что считать ожиданием, знает
 * только панель — поэтому здесь.
 */

/** Тик проводки: пинг нужен в окне 50–60 минут, минутного шага хватает. */
export const KEEP_WARM_TICK_MS = 60_000;

export interface KeepWarmWiringDeps {
  /** Рычаги экономии групп с умолчаниями — на каждом тике: человек меняет их на лету. */
  economy: () => GroupEconomy | undefined;
  /** Порог окна сторожа групп (`coldContextTokens`). */
  coldContextTokens: () => number;
  plans: () => Record<string, SplitPlanRecord>;
  asksOf: (keys: readonly string[]) => ChatTreeAsk[];
  /** Настоящий ключ разговора по любому его написанию (временный `new-…` → id сессии). */
  canonical?: (chatId: string) => string;
  projectsDir: () => string;
  heavyQueueDir: string;
  /** Каталог данных панели: учёт пингов (`keep-warm.json`) и журнал лимита. */
  appDataDir: string;
  /** Сторож групп: отметка «согрето» для R2. */
  watcher?: { warmed(sessionId: string, at: number, lastCallAt: number): void };
  /** Записан исход пинга в счёт группы — вкладкам перечитать дерево. */
  changed?: (parentChatId: string) => void;
  /** Мост прав пинга к этой панели под ключом пинга (RF-EF-07); без него — мост хода как есть. */
  bridge?: (runId: string) => NonNullable<RunOptions['permissionPrompt']>;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

export interface KeepWarmWiring {
  /**
   * Один проход: решения по всем ждущим группам и запуск пингов. Промис — конец
   * пингов, начатых этим проходом; следующий проход их не ждёт: зависший пинг
   * одной группы не держит остальные (у каждой сессии свой «в пути»).
   */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

type Runs = Pick<ChatRunRegistry, 'warm' | 'latestRunOf' | 'isRunning'>;

/** Чего ждёт группа — в терминах пинга; не ждёт — пусто. */
function waitOf(
  group: SplitPlanGroupRecord,
  asks: readonly ChatTreeAsk[],
  inHeavyQueue: boolean,
): KeepWarmWait | undefined {
  if (group.status === 'done' || group.status === 'failed' || group.droppedAt) return undefined;
  if (asks.length > 0) return 'ask';
  // Ожидание сброса лимита (`waitingFor: 'limit'`) пинга не получает: ни пока
  // лимит исчерпан, ни после — дальше группа пойдёт сама.
  if (
    group.status === 'awaiting' &&
    (group.waitingFor === 'question' || group.waitingFor === 'decision')
  ) {
    // Ожидание решения по D-n (`human-op`) — НЕ сюда (решение 6): человек
    // решает его когда угодно, и пинги до того жгли бы окно впустую.
    return 'ask';
  }
  if (group.status === 'paused') return 'paused';
  if (inHeavyQueue) return 'heavy-queue';
  return undefined;
}

/** Учёт ожидания: то же ожидание — как было; новое (был вызов модели) — с нуля, шаблон остаётся. */
function stateOfWait(
  prev: KeepWarmSessionState | undefined,
  waitKey: number,
  at: number,
): KeepWarmSessionState {
  if (prev?.waitKey === waitKey) return prev;
  return {
    waitKey,
    pings: 0,
    ...(prev?.template ? { template: prev.template } : {}),
    touchedAt: at,
  };
}

export function wireKeepWarm(runs: Runs, deps: KeepWarmWiringDeps): KeepWarmWiring {
  const now = deps.now ?? Date.now;
  const path = keepWarmPath(deps.appDataDir);
  const inFlight = new Set<string>();
  // Причина последнего пропуска сессии: в журнал — только смена, а не каждый тик.
  const skipped = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;

  /** Счёт группы изменился — вкладкам перечитать дерево; сбой рассылки пинги не трогает. */
  const notify = (parentChatId: string): void => {
    try {
      deps.changed?.(parentChatId);
    } catch (error) {
      deps.log?.('[keep-warm] change broadcast failed', error);
    }
  };

  const skip = (sessionId: string, reason: string): void => {
    if (skipped.get(sessionId) === reason) return;
    skipped.set(sessionId, reason);
    deps.log?.(`[keep-warm] ${sessionId}: skip ${reason}`);
  };

  /**
   * Сессия группы и параметры её хода. Параметры из журнала прогонов после
   * перезапуска (`adopted`) пинга не собирают — в них нет вводной группы и слоёв;
   * тогда — шаблон учёта, а нет его — пинга нет.
   */
  const sessionOf = (
    keys: readonly string[],
  ): { sessionId: string; options?: RunOptions; meta?: RunMeta } | undefined => {
    const latest = runs.latestRunOf(keys);
    if (latest) {
      return latest.adopted
        ? { sessionId: latest.sessionId }
        : { sessionId: latest.sessionId, options: latest.options, meta: latest.meta };
    }
    const id = keys.find((key) => !key.startsWith('new-'));
    return id ? { sessionId: id } : undefined;
  };

  const settle = (
    ping: {
      sessionId: string;
      parentChatId: string;
      index: number;
      wait: KeepWarmWait;
      lastCallAt: number;
      contextTokens: number;
      model: string | undefined;
    },
    outcome: WarmOutcome,
  ): void => {
    const { sessionId, parentChatId, index } = ping;
    const doneAt = now();
    const usage = outcome.usage;
    const reached = outcome.toolStopped || usage.input + usage.cacheRead + usage.cacheWrite > 0;
    const verdict = reached ? pingVerdict(usage, ping.contextTokens) : undefined;
    deps.log?.(
      `[keep-warm] ping ${sessionId} (${parentChatId}#${index}, ${ping.wait}): ` +
        `${verdict ?? 'not reached'} read ${usage.cacheRead}/${ping.contextTokens} ` +
        `write ${usage.cacheWrite} (1h ${usage.cacheWrite1h}) in ${usage.input} out ${usage.output}` +
        (outcome.error ? ` error ${outcome.error}` : '') +
        (outcome.toolStopped ? ' tool-stopped' : '') +
        (outcome.stopUnconfirmed ? ' stop-unconfirmed' : ''),
    );
    const latest = readKeepWarm(path);
    const entry = latest.sessions[sessionId] ?? stateOfWait(undefined, ping.lastCallAt, doneAt);
    const key = keepWarmGroupKey(parentChatId, index);
    const cost = verdict ? pingCost(usage, ping.model) : 0;
    latest.sessions[sessionId] = {
      ...entry,
      // Потолок считает пинги, дошедшие до модели: сорвавшийся повторится через пять минут.
      // Их расход ждёт итога ожидания: экономию решит продолжение (`settleWait`).
      ...(verdict
        ? {
            pings: entry.pings + 1,
            spent: (entry.spent ?? 0) + cost,
            contextTokens: entry.contextTokens ?? ping.contextTokens,
            ...((entry.model ?? ping.model) ? { model: entry.model ?? ping.model } : {}),
            group: key,
          }
        : {}),
      ...(verdict === 'hit' ? { warmedAt: doneAt } : {}),
      ...(verdict === 'miss' ? { missed: true as const } : {}),
      ...(usage.cacheWrite > 0 && usage.cacheWrite1h === 0 ? { ttl5m: true as const } : {}),
      touchedAt: doneAt,
    };
    if (outcome.limited) latest.limitedUntil = outcome.limited.resetsAt * 1000;
    if (verdict) {
      latest.groups = {
        ...latest.groups,
        [key]: addPing(latest.groups?.[key], usage, verdict, cost, new Date(doneAt).toISOString()),
      };
    }
    writeKeepWarm(path, latest, doneAt);
    // Промах кэша не согрел: решение о продолжении и сторож R2 судят по времени хода.
    if (verdict === 'hit') deps.watcher?.warmed(sessionId, doneAt, ping.lastCallAt);
    if (verdict) notify(parentChatId);
  };

  /**
   * Итоги ожиданий с пингами: продолжение уже было или кэш остыл и так —
   * расход пингов уходит из «ожидающих итога», экономия засчитывается только
   * состоявшаяся. Идёт и при выключенном рычаге: начатые ожидания досчитываются.
   */
  const settleWaits = (file: KeepWarmFile, at: number): boolean => {
    let dirty = false;
    for (const [sessionId, state] of Object.entries(file.sessions)) {
      if (state.spent === undefined || inFlight.has(sessionId)) continue;
      const transcript = findTranscript(deps.projectsDir(), sessionId);
      const resume = transcript ? firstCallAfter(transcript, state.waitKey) : undefined;
      // Ход идёт, а вызова в транскрипте ещё нет: продолжение уже ушло к модели,
      // ответ допишется в конце. «Кэш остыл без продолжения» тогда не итог —
      // его подведёт сам вызов, когда запишется.
      if (!resume && runs.isRunning(sessionId)) continue;
      const result = settleWait(state, resume, at);
      if (!result) continue;
      const { spent, contextTokens: _window, model: _model, group, ...rest } = state;
      file.sessions[sessionId] = { ...rest, touchedAt: at };
      const ledger = group ? file.groups?.[group] : undefined;
      if (group && ledger) {
        file.groups = { ...file.groups, [group]: settleGroup(ledger, spent, result.avoided) };
        notify(group.slice(0, group.lastIndexOf('#')));
      }
      deps.log?.(
        `[keep-warm] wait ${sessionId} settled: ` +
          `${result.avoided > 0 ? `resume read the kept cache, avoided ${result.avoided}` : 'pings were cost only'}, spent ${spent}`,
      );
      dirty = true;
    }
    return dirty;
  };

  const pass = (): Promise<void>[] => {
    const at = now();
    const file: KeepWarmFile = readKeepWarm(path);
    let dirty = settleWaits(file, at);
    const economy = deps.economy();
    if (!economy?.keepWarm) {
      if (dirty) writeKeepWarm(path, file, at);
      return [];
    }
    let limited: boolean | undefined;
    const pings: Promise<void>[] = [];
    const plans = Object.values(deps.plans());
    const rateLimited = (): boolean => {
      if (limited !== undefined) return limited;
      // Отказ лимита, ждущий сброса, — у группы или у плана; предупреждение «на
      // исходе» (`limitWarning`) группы не останавливает и пинги тоже. Лимит
      // подписки общий: ожидание его сброса глушит пинги всех групп.
      const ahead = (until: string | undefined): boolean =>
        until !== undefined && Date.parse(until) > at;
      const groupLimit = plans.some(
        (plan) =>
          (ahead(plan.limitUntil) && !plan.limitWarning) ||
          plan.groups.some((group) => ahead(group.limitUntil)),
      );
      limited =
        groupLimit ||
        (file.limitedUntil !== undefined && file.limitedUntil > at) ||
        rateLimitedNow(readLimitRuns(deps.appDataDir), at);
      return limited;
    };
    for (const plan of plans) {
      for (const group of plan.groups) {
        if (!group.chatId) continue;
        const keys = [...new Set([group.chatId, deps.canonical?.(group.chatId) ?? group.chatId])];
        const sessions = keys.filter((key) => !key.startsWith('new-'));
        const heavy = sessions.some((key) => heavyQueueWait(deps.heavyQueueDir, key));
        const wait = waitOf(group, deps.asksOf(keys), heavy);
        if (!wait) continue;
        const found = sessionOf(keys);
        if (!found || inFlight.has(found.sessionId)) continue;
        const { sessionId } = found;
        const transcript = findTranscript(deps.projectsDir(), sessionId);
        const tail = transcript ? sessionCallTail(transcript) : undefined;
        const state = file.sessions[sessionId];
        // Шаблон — в учёт сразу, пока ход в памяти: перезапуск панели посреди
        // ожидания иначе оставил бы пинг без параметров.
        const fresh = found.options
          ? keepWarmTemplate(found.options, found.meta?.origin)
          : undefined;
        if (fresh && JSON.stringify(fresh) !== JSON.stringify(state?.template)) {
          file.sessions[sessionId] = {
            ...(state ?? { waitKey: tail?.lastCallAt ?? 0, pings: 0 }),
            template: fresh,
            touchedAt: at,
          };
          dirty = true;
        }
        const decision = decideKeepWarm({
          economy,
          coldContextTokens: deps.coldContextTokens(),
          wait,
          running: runs.isRunning(group.chatId, sessionId),
          tail,
          state: file.sessions[sessionId],
          rateLimited: false,
          now: at,
        });
        if (decision.kind === 'skip') {
          skip(sessionId, decision.reason);
          continue;
        }
        // Лимит читается только под настоящий кандидат: журнал на каждом тике не нужен.
        if (rateLimited()) {
          skip(sessionId, 'rate-limited');
          continue;
        }
        const template = file.sessions[sessionId]?.template;
        const copied =
          found.options ?? (template ? templateOptions(template, sessionId) : undefined);
        // Мост прав пинга — к этой панели, а не копия моста хода (RF-EF-07, как F-45):
        // ход, продолженный из подхваченного после перезапуска, несёт пустой адрес
        // (`run-reattach.ts`), и шаблон в учёте пингов хранит его же.
        const options =
          copied?.permissionPrompt && deps.bridge
            ? { ...copied, permissionPrompt: deps.bridge(`keep-warm-${sessionId}`) }
            : copied;
        if (!options || !tail) {
          skip(sessionId, 'no-template');
          continue;
        }
        skipped.delete(sessionId);
        const meta: RunMeta = found.meta ?? {
          ...(template?.origin ? { origin: template.origin as RunMeta['origin'] } : {}),
          sessionId,
        };
        file.sessions[sessionId] = {
          ...stateOfWait(file.sessions[sessionId], decision.waitKey, at),
          lastPingAt: at,
          touchedAt: at,
        };
        dirty = true;
        inFlight.add(sessionId);
        const ping = {
          sessionId,
          parentChatId: plan.parentChatId,
          index: group.index,
          wait,
          lastCallAt: tail.lastCallAt,
          contextTokens: tail.contextTokens,
          model: options.model,
        };
        pings.push(
          runs
            .warm(
              keys.includes(sessionId) ? keys : [...keys, sessionId],
              sessionId,
              options,
              meta,
              KEEP_WARM_PROMPT,
            )
            .then((outcome) => settle(ping, outcome))
            .catch((error: unknown) => {
              deps.log?.(`[keep-warm] ping ${sessionId} failed`, error);
            })
            .finally(() => {
              inFlight.delete(sessionId);
            }),
        );
      }
    }
    if (dirty) writeKeepWarm(path, file, at);
    return pings;
  };

  return {
    tick: async () => {
      await Promise.all(pass());
    },
    start: () => {
      if (timer) return;
      timer = setInterval(() => {
        void Promise.resolve()
          .then(() => Promise.all(pass()))
          .catch((error: unknown) => deps.log?.('[keep-warm] tick failed', error));
      }, KEEP_WARM_TICK_MS);
      timer.unref();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
