import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GroupSignal, GroupWatch } from '@agentdeck/contracts/group-watch';
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
  type WatchTarget,
} from '../../domains/chat/token-ledger/watch/group-watcher.ts';
import {
  loadLearnedDurations,
  type LearnedDurations,
} from '../../domains/chat/token-ledger/watch/check-signature.ts';
import { heavyQueueWait } from '../../domains/group-progress/heavy-wait.ts';
import { sessionHoldsLease } from '../../domains/chat/heavy-queue-leases/heavy-queue-leases.ts';
import { groupDeliverAhead } from '../../domains/chat/split-conveyor/split-conveyor.ts';

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
  save: (record: SplitPlanRecord) => void;
  asksOf: (keys: readonly string[]) => ChatTreeAsk[];
  projectsDir: () => string;
  heavyQueueDir: string;
  notify?: (signal: GroupSignal, target: WatchTarget) => void;
  /** Настоящий ключ разговора по любому его написанию (временный `new-…` → id сессии). */
  canonical?: (chatId: string) => string;
  panelRoot?: string;
  log?: (message: string, error?: unknown) => void;
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

export function wireGroupWatch(
  chatRuns: ChatRunRegistry,
  deps: GroupWatchWiringDeps,
): GroupWatcher {
  let learned: { at: number; value: LearnedDurations } | undefined;
  /** sessionId → транскрипт сессии; промах помнится минуту, чтобы не обходить projects на каждом тике. */
  const transcripts = new Map<string, string | { missAt: number }>();
  const transcript = (sessionId: string): string | undefined => {
    const known = transcripts.get(sessionId);
    if (typeof known === 'string') return known;
    if (known && Date.now() - known.missAt < TRANSCRIPT_MISS_TTL_MS) return undefined;
    const found = findTranscript(deps.projectsDir(), sessionId);
    transcripts.set(sessionId, found ?? { missAt: Date.now() });
    return found;
  };
  const group = (parentChatId: string, index: number): SplitPlanGroupRecord | undefined =>
    deps.plan(parentChatId)?.groups.find((candidate) => candidate.index === index);

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
      return undefined;
    },
    group,
    save: (parentChatId) => {
      const record = deps.plan(parentChatId);
      if (record) deps.save(record);
    },
    plans: deps.plans,
    node: (target, keys) => {
      const record = group(target.parentChatId, target.groupIndex);
      // Запрос прав тоже ждёт человека: молчание звена при нём — не зависание (R1), а R1b.
      const ask = deps.asksOf(keys).sort((a, b) => a.askedAt.localeCompare(b.askedAt))[0];
      const question = ask ? askQuestion(ask) : undefined;
      const askedAt = ask ? Date.parse(ask.askedAt) : NaN;
      const sessions = keys.filter((key) => !key.startsWith('new-'));
      return {
        running: Boolean(record && RUNNING.has(record.status)),
        paused: record?.status === 'paused',
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
        // Ждёт места в очереди или держит аренду — идёт долгая проверка, не зависание.
        ...(sessions.some(
          (key) =>
            heavyQueueWait(deps.heavyQueueDir, key) !== undefined ||
            sessionHoldsLease(deps.heavyQueueDir, key),
        )
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
    panelRoot: deps.panelRoot ?? PANEL_ROOT,
    learned: () => {
      const now = Date.now();
      if (!learned || now - learned.at > LEARNED_TTL_MS) {
        learned = { at: now, value: loadLearnedDurations(deps.heavyQueueDir) };
      }
      return learned.value;
    },
    ...(deps.log ? { log: deps.log } : {}),
  });
  chatRuns.setWatchListener(watcher.onFeed);
  watcher.start();
  return watcher;
}
