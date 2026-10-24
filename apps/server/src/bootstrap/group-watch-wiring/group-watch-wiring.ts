import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHAT_SCOPE_INDEX,
  type GroupSignal,
  type GroupWatch,
} from '@agentdeck/contracts/group-watch';
import type { ChatTreeAsk } from '@agentdeck/contracts/chat-handoff';
import type {
  ChatLink,
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../lib/app-store/app-store.types.ts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { findTranscript } from '../../domains/chat/ChatTranscriptFile/ChatTranscriptFile.ts';
import {
  GroupWatcher,
  type ChatSignalStore,
  type GroupLive,
  type TranscriptHint,
  type WatchSignalStore,
  type WatchTarget,
} from '../../domains/chat/token-ledger/watch/group-watcher.ts';
import {
  findForeignTranscript,
  foreignTranscriptKind,
  newestForeignTranscript,
} from '../../domains/chat/token-ledger/foreign/foreign-transcript.ts';
import { foreignHomes } from '../../domains/analytics/scanner/foreign.ts';
import {
  loadLearnedDurations,
  maskCommand,
  type LearnedDurations,
} from '../../domains/chat/token-ledger/watch/check-signature.ts';
import { createFiveHourReader } from '../../domains/chat/limit-journal/limit-journal.ts';
import { heavyQueueWait } from '../../domains/group-progress/heavy-wait.ts';
import { sessionHoldsLease } from '../../domains/chat/heavy-queue-leases/heavy-queue-leases.ts';
import { groupDeliverAhead } from '../../domains/chat/split-conveyor/split-conveyor.ts';
import { createPortProbe } from './port-probe.ts';

/**
 * Проводка сторожа групп (фаза 2, W): реестр прогонов → `GroupWatcher`. Здесь
 * всё, что сторож знает о панели: связь разговора со звеном, статус группы,
 * вопрос человеку, билет очереди тяжёлых шагов, каталог субагентов, корень
 * самой панели (чтения оттуда из копии — R7).
 */

/** Корень репозитория панели: отсюда пять уровней вверх. */
const PANEL_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
/** Опыт очереди перечитывается не чаще раза в пять минут: файл меняется редко. */
const LEARNED_TTL_MS = 5 * 60_000;
/** Статусы, при которых группа идёт: молчание звена — повод для R1. */
const RUNNING = new Set(['started', 'background']);
/** Транскрипта сессии ещё нет (или CLI не Claude) — искать снова не раньше чем через минуту. */
const TRANSCRIPT_MISS_TTL_MS = 60_000;

export interface GroupWatchWiringDeps {
  settings: () => GroupWatch;
  link: (chatId: string) => ChatLink | undefined;
  plan: (parentChatId: string) => SplitPlanRecord | undefined;
  plans: () => Record<string, SplitPlanRecord>;
  /** Срез сигналов сторожа в хранилище (F-42): пишет только сторож; `save` — на диск. */
  signals: WatchSignalStore & { save: () => void };
  asksOf: (keys: readonly string[]) => ChatTreeAsk[];
  /**
   * Группа ждёт решения человека по D-n: стоит законно (R22), как с открытым
   * вопросом. Нет — отложенных вопросов сторож не видит.
   */
  deferredWaiting?: (parentChatId: string, groupIndex: number) => boolean;
  projectsDir: () => string;
  heavyQueueDir: string;
  notify?: (signal: GroupSignal, target: WatchTarget) => void;
  /** Настоящий ключ разговора по любому его написанию (временный `new-…` → id сессии). */
  canonical?: (chatId: string) => string;
  panelRoot?: string;
  /** Каталог данных панели: журнал лимита всех прогонов — замеры окна для R9. */
  appDataDir?: string;
  /** Домашний каталог для `~/…` в командах (R7); нет — домашний каталог процесса. */
  home?: string;
  /** Свой срок остывания кэша чужого CLI (R2) — для живой проверки; нет — срок провайдера. */
  foreignColdAfterMs?: () => number | undefined;
  /** Сторож записал сигналы разделения — вкладкам перечитать дерево (без ожидания опроса). */
  changed?: (parentChatId: string) => void;
  /**
   * Срез сигналов одиночных чатов (A1); нет — одиночные чаты не под наблюдением.
   * На диск — тем же `signals.save`.
   */
  chatSignals?: ChatSignalStore;
  /** Сторож записал сигналы одиночного чата — строке чата и шапке перечитать. */
  chatChanged?: (chatId: string) => void;
  /** Служебный прогон панели (вопрос о ходе групп): одиночным чатом человека не считается. */
  internal?: (keys: readonly string[]) => boolean;
  /** Все связи дерева: ключи группы для R22 (звенья, ревью, доставка). */
  links?: () => Record<string, ChatLink>;
  /** Дерево на паузе («Остановить всё»): группа стоит законно (R22), действует на ней — R20. */
  treePaused?: (chatId: string) => boolean;
  /**
   * Когда дерево встало на паузу (мс), по любому ключу дерева. Нет — время паузы
   * дерева сторож берёт с первого раза, когда увидел её (R20 с запасом в тик).
   */
  treePausedAt?: (chatId: string) => number | undefined;
  log?: (message: string, error?: unknown) => void;
}

/**
 * Полный путь существующего файла (короткое имя 8.3 развёрнуто); нет файла или
 * не прочитать — `undefined`: сторож сравнит путь как есть.
 */
function realPath(path: string): string | undefined {
  try {
    return existsSync(path) ? realpathSync.native(path) : undefined;
  } catch {
    return undefined;
  }
}

/** Текст вопроса из записи ожидания: первый вопрос `AskUserQuestion` или текст; у запроса прав текста нет. */
function askQuestion(ask: ChatTreeAsk): string | undefined {
  if (ask.text) return ask.text;
  if (ask.kind === 'permission') return undefined;
  const questions = (ask.input as { questions?: Array<{ question?: unknown }> } | undefined)
    ?.questions;
  const first = Array.isArray(questions) ? questions[0]?.question : undefined;
  return typeof first === 'string' && first ? first : undefined;
}

/**
 * Ожидание сессии в очереди тяжёлых шагов (R17): самый ранний билет из всех её
 * ключей, впереди — по нему же; команда — под маской, как в строке R4.
 */
function queueWait(
  dir: string,
  sessions: readonly string[],
): { since: number; ahead: number; command?: string } | undefined {
  let found: { since: number; ahead: number; command?: string } | undefined;
  for (const key of sessions) {
    const wait = heavyQueueWait(dir, key);
    const since = wait ? Date.parse(wait.since) : NaN;
    if (!wait || !Number.isFinite(since) || (found && found.since <= since)) continue;
    found = {
      since,
      ahead: wait.ahead,
      ...(wait.command ? { command: maskCommand(wait.command) } : {}),
    };
  }
  return found;
}

export function wireGroupWatch(
  chatRuns: ChatRunRegistry,
  deps: GroupWatchWiringDeps,
): GroupWatcher {
  let learned: { at: number; value: LearnedDurations } | undefined;
  const ports = createPortProbe();
  /** sessionId → транскрипт сессии; промах помнится минуту, чтобы не обходить projects на каждом тике. */
  const transcripts = new Map<string, string | { missAt: number }>();
  const remembered = (key: string, find: () => string | undefined): string | undefined => {
    const known = transcripts.get(key);
    if (typeof known === 'string') return known;
    if (known && Date.now() - known.missAt < TRANSCRIPT_MISS_TTL_MS) return undefined;
    const found = find();
    transcripts.set(key, found ?? { missAt: Date.now() });
    return found;
  };
  const transcript = (sessionId: string, hint?: TranscriptHint): string | undefined => {
    if (!hint) return remembered(sessionId, () => findTranscript(deps.projectsDir(), sessionId));
    const kind = foreignTranscriptKind(hint.provider);
    if (!kind || !deps.appDataDir) return undefined;
    const homes = foreignHomes(kind, deps.appDataDir);
    // Первый ход: id сессии CLI ещё не известен, на его месте ключ разговора
    // (`qwen:…`). Его файл — свежая сессия в каталоге копии, начатая в этом ходе;
    // находка не запоминается — ключ один на все будущие разговоры звена.
    if (sessionId.includes(':')) {
      return hint.cwd && hint.since !== undefined
        ? newestForeignTranscript(kind, homes, hint.cwd, hint.since)
        : undefined;
    }
    return remembered(`${kind}:${sessionId}`, () =>
      findForeignTranscript(kind, homes, sessionId, hint.cwd),
    );
  };
  const group = (parentChatId: string, index: number): SplitPlanGroupRecord | undefined =>
    deps.plan(parentChatId)?.groups.find((candidate) => candidate.index === index);
  /** Все ключи группы: связи её разговоров (звено, ревью, доставка) и чат записи. */
  const groupKeys = (
    parentChatId: string,
    record: SplitPlanGroupRecord,
    watched: readonly string[] = [],
  ): string[] => {
    const keys = new Set<string>([...watched, ...(record.chatId ? [record.chatId] : [])]);
    for (const [key, link] of Object.entries(deps.links?.() ?? {})) {
      if (link.parentChatId === parentChatId && link.groupIndex === record.index) keys.add(key);
    }
    return [...keys];
  };
  // «Остановить всё» заводится в сборке позже сторожа: до неё дерево не на паузе.
  const treePaused = (chatId: string): boolean => {
    try {
      return deps.treePaused?.(chatId) ?? false;
    } catch {
      return false;
    }
  };
  /** Родитель → когда сторож впервые увидел его дерево на паузе (если дерево время не назвало). */
  const treeSeenPaused = new Map<string, number>();
  /**
   * Время паузы дерева разговора или `undefined`, если дерево идёт (F-54): пауза
   * дерева статус группы не меняет, а R20 без метки паузы молчит.
   */
  const treePauseOf = (parentChatId: string): number | undefined => {
    if (!treePaused(parentChatId)) {
      treeSeenPaused.delete(parentChatId);
      return undefined;
    }
    let at: number | undefined;
    try {
      at = deps.treePausedAt?.(parentChatId);
    } catch {
      at = undefined;
    }
    if (at !== undefined && Number.isFinite(at)) return at;
    const seen = treeSeenPaused.get(parentChatId) ?? Date.now();
    treeSeenPaused.set(parentChatId, seen);
    return seen;
  };
  const groupLive = (
    parentChatId: string,
    record: SplitPlanGroupRecord,
    watched: readonly string[],
  ): GroupLive => {
    const keys = groupKeys(parentChatId, record, watched);
    const sessions = keys.filter((key) => !key.startsWith('new-'));
    return {
      running: keys.some(
        (key) => chatRuns.isRunning(key) || chatRuns.idleWithBackground(key) !== undefined,
      ),
      ask:
        deps.asksOf(keys).length > 0 || deps.deferredWaiting?.(parentChatId, record.index) === true,
      queued:
        queueWait(deps.heavyQueueDir, sessions) !== undefined ||
        sessions.some((key) => sessionHoldsLease(deps.heavyQueueDir, key)),
      paused: treePaused(parentChatId),
    };
  };
  /** Последняя запись в переписку любого звена группы — затравка тишины R22 после перезапуска. */
  const groupSeenAt = (parentChatId: string, record: SplitPlanGroupRecord): number | undefined => {
    let newest: number | undefined;
    for (const key of groupKeys(parentChatId, record)) {
      if (key.startsWith('new-') || key.includes(':')) continue;
      const file = transcript(key);
      if (!file) continue;
      try {
        const at = statSync(file).mtimeMs;
        if (newest === undefined || at > newest) newest = at;
      } catch {
        // Файл ушёл между поиском и чтением — мимо: затравка возьмёт старт группы.
      }
    }
    return newest;
  };
  /**
   * Одиночный чат панели: слежка включена, ни у одного ключа нет связи с деревом
   * (связь есть у звеньев, разбора, ревью, доставки — её пишут до старта), и прогон
   * не служебный. Разговоры, начатые не панелью, сюда не попадают: их нет в реестре.
   */
  const chatTarget = (chatId: string, sessionId: string | undefined): WatchTarget | undefined => {
    if (!deps.chatSignals || !deps.settings().singleChats) return undefined;
    const keys = sessionId ? [chatId, sessionId] : [chatId];
    if (keys.some((key) => deps.link(key) !== undefined)) return undefined;
    if (deps.internal?.(keys)) return undefined;
    return { scope: 'chat', chatId, parentChatId: chatId, groupIndex: CHAT_SCOPE_INDEX };
  };

  const watcher = new GroupWatcher({
    settings: deps.settings,
    resolve: (chatId, sessionId) => {
      for (const key of [chatId, sessionId]) {
        if (!key) continue;
        const link = deps.link(key);
        if (!link?.parentChatId || link.groupIndex === undefined) continue;
        const record = group(link.parentChatId, link.groupIndex);
        return {
          chatId: key,
          parentChatId: link.parentChatId,
          groupIndex: link.groupIndex,
          stage: link.stage ?? 'work',
          ...(record?.path ? { cwd: record.path } : {}),
        };
      }
      return chatTarget(chatId, sessionId);
    },
    group,
    signals: deps.signals,
    ...(deps.chatSignals
      ? {
          chatSignals: deps.chatSignals,
          saveChat: (chatId: string) => {
            deps.signals.save();
            try {
              deps.chatChanged?.(chatId);
            } catch (error) {
              deps.log?.('[group-watch] chat change broadcast failed', error);
            }
          },
        }
      : {}),
    groupLive,
    groupSeenAt,
    save: (parentChatId) => {
      deps.signals.save();
      // Рассылка — после записи: сбой записи бросает, и вкладкам перечитывать нечего.
      try {
        deps.changed?.(parentChatId);
      } catch (error) {
        deps.log?.('[group-watch] change broadcast failed', error);
      }
    },
    plans: deps.plans,
    node: (target, keys) => {
      const chat = target.scope === 'chat';
      const record = chat ? undefined : group(target.parentChatId, target.groupIndex);
      // Стадия — живая из связи: тот же разговор мог перейти из работы в ревью (R29, R33).
      const link = chat
        ? undefined
        : keys.map((key) => deps.link(key)).find((one) => one?.groupIndex === target.groupIndex);
      const stage = link?.stage;
      // Начало звена: коммиты раньше — работа прошлой стадии, их переделка не R35.
      const stageSince = link?.stageSince ? Date.parse(link.stageSince) : NaN;
      // Запрос прав тоже ждёт человека: молчание звена при нём — не зависание (R1), а R1b.
      const ask = deps.asksOf(keys).sort((a, b) => a.askedAt.localeCompare(b.askedAt))[0];
      const question = ask ? askQuestion(ask) : undefined;
      const askedAt = ask ? Date.parse(ask.askedAt) : NaN;
      const sessions = keys.filter((key) => !key.startsWith('new-'));
      const wait = queueWait(deps.heavyQueueDir, sessions);
      const groupPaused = record?.status === 'paused';
      // Пауза дерева («Остановить всё») статусы групп не трогает — та же пауза (F-54).
      const treeAt = chat || groupPaused ? undefined : treePauseOf(target.parentChatId);
      const paused = groupPaused || treeAt !== undefined;
      // Действия позже этой метки — группа работает на паузе (R20). Битой метки нет — R20 молчит.
      const pausedAt =
        groupPaused && record.pausedAt ? Date.parse(record.pausedAt) : (treeAt ?? NaN);
      return {
        // У одиночного чата статуса группы нет: идёт ли он — по реестру прогонов.
        running: chat
          ? keys.some((key) => chatRuns.isRunning(key))
          : Boolean(record && RUNNING.has(record.status)),
        paused,
        ...(stage ? { stage } : {}),
        // Вопрос текстом подхватить некому (R27): у группы продолжение по ожиданию
        // начинает новый ход за миллисекунды (он и снимает конец хода), так что
        // висящий конец хода — значит, попытки кончились; у чата — включена автономия.
        ...((chat ? keys.some((key) => chatRuns.isAutonomous(key)) : true)
          ? { proseWait: true }
          : {}),
        ...(Number.isFinite(pausedAt) ? { pausedAt } : {}),
        // Битое время записи — «сейчас»: ожидание есть, срок от него не посчитать.
        ...(ask
          ? {
              ask: {
                since: Number.isFinite(askedAt) ? askedAt : Date.now(),
                ...(question ? { question } : {}),
              },
            }
          : {}),
        ...(groupDeliverAhead(record) ? { deliverAhead: true } : {}),
        ...(Number.isFinite(stageSince) ? { stageSince } : {}),
        // Ждёт места в очереди (R17) и держит аренду — разное: оба не зависание (R1), но ожидание — задержка.
        ...(wait ? { heavyWait: wait } : {}),
        ...(sessions.some((key) => sessionHoldsLease(deps.heavyQueueDir, key))
          ? { heavyLease: true }
          : {}),
      };
    },
    subagentDir: (sessionId) => {
      const file = transcript(sessionId);
      return file ? join(dirname(file), sessionId, 'subagents') : undefined;
    },
    transcript,
    ...(deps.notify ? { notify: deps.notify } : {}),
    ...(deps.canonical ? { canonical: deps.canonical } : {}),
    // Корень панели — полным путём: копия, открытая под коротким именем, иначе не совпала бы.
    panelRoot: realPath(deps.panelRoot ?? PANEL_ROOT) ?? deps.panelRoot ?? PANEL_ROOT,
    home: deps.home ?? homedir(),
    realPath,
    ...(deps.appDataDir ? { limitSamples: createFiveHourReader(deps.appDataDir) } : {}),
    learned: () => {
      const now = Date.now();
      if (!learned || now - learned.at > LEARNED_TTL_MS) {
        learned = { at: now, value: loadLearnedDurations(deps.heavyQueueDir) };
      }
      return learned.value;
    },
    ...(deps.foreignColdAfterMs ? { foreignColdAfterMs: deps.foreignColdAfterMs } : {}),
    // Свой сервер сессии на паузе группы (R36): ответ по последней пробе соединения.
    portAlive: ports.alive,
    ...(deps.log ? { log: deps.log } : {}),
  });
  chatRuns.setWatchListener(watcher.onFeed);
  watcher.start();
  return watcher;
}
