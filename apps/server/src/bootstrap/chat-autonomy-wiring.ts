import type { ChatEvent } from '../domains/chat/chat-events.ts';
import type { ChatRunRegistry } from '../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import {
  chatGroupSettingsView,
  rootChatOf,
  storeTreeReader,
} from '../domains/chat/chat-autonomy/chat-autonomy.ts';
import { createEscalations } from '../domains/chat/escalations/escalations.ts';
import { groupAutoApproveFor } from '../domains/chat/group-permissions.ts';
import { recordGroupAnswerNotice } from '../domains/chat/group-questions/group-questions.ts';
import {
  GroupWaitResume,
  type WaitResumeCounter,
} from '../domains/chat/group-questions/group-wait.ts';
import type { RunOptions } from '../domains/chat/ChatRunner/ChatRunner.ts';
import type { RunFinished } from '../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { TreeStartGate } from '../domains/chat/tree-pause/tree-pause.ts';
import type { AppStore } from '../lib/app-store/store.ts';

/**
 * Группа, автономность и заметки главному чату — сборка на реестре прогонов.
 *
 * Отдельным модулем, а не строками в `runtime.ts`: там сходятся все полосы, и
 * каждая строка чужой правки — конфликт. Здесь три вопроса реестру (автономен
 * ли прогон, что выбрано автономией, чем кончился ход). Выбранная группа
 * включается на каждом старте обоих провайдеров (`group-activation-wiring.ts`).
 */
export interface ChatAutonomyWiringDeps {
  store: AppStore;
  chatRuns: ChatRunRegistry;
  /** Слова панели в ленту главного чата — та же развилка Claude/чужой CLI. */
  say: (chatId: string, event: ChatEvent) => boolean;
  /** Разослать «изменилось» по домену — открытые окна перечитают заметки. */
  broadcast: (domains: string[], path: string) => void;
  /** Мост прав хода, который панель заводит сама, — к этой панели (`handoff-routes.ts`). */
  bridge?: (runId: string) => RunOptions['permissionPrompt'];
  /**
   * Воротца «Остановить всё» (F-44): продолжение группы «по плану» на стоящем
   * дереве ложится в очередь паузы, как шаг конвейера, а не стартует поверх неё.
   */
  gate?: Pick<TreeStartGate, 'defer'>;
  /**
   * Реестр отказал в старте продолжения (F-44): планировщик этот конец уже
   * пропустил — здесь его проводят обычным путём (вопросы хаба, конвейер, повтор).
   */
  refused?: (finished: RunFinished) => void;
}

export interface ChatAutonomyWiring {
  /** Конец хода любого провайдера: блоки замечаний из ответа ребёнка. */
  finished: (keys: readonly string[], text: string) => void;
  /**
   * Ход группы «по плану» кончился ожиданием ответа текстом — панель продолжила
   * ту же сессию сама (`group-wait.ts`); `true` — планировщику этот конец не нужен.
   */
  resumeWaiting: (finished: RunFinished) => boolean;
  /** Старт разговора — счёт продолжений снимает только чужой старт. */
  started: (keys: readonly string[]) => void;
}

export function wireChatAutonomy(deps: ChatAutonomyWiringDeps): ChatAutonomyWiring {
  const reader = storeTreeReader(deps.store);
  const escalations = createEscalations({
    canonical: (key) => deps.store.canonicalChatKey(key),
    parentOf: reader.parentOf,
    titleOf: (key) => deps.store.getChatLink(key)?.title,
    rootOf: (keys) => rootChatOf(reader, keys),
    store: (root, notice) => deps.store.addChatEscalation(root, notice),
    say: deps.say,
    changed: () => deps.broadcast(['chat-escalations'], ''),
  });

  deps.chatRuns.setAutonomyResolver((keys) => chatGroupSettingsView(reader, keys).autonomous);
  // Вопросы группы «по плану» панель закрывает сама (`group-questions.ts`):
  // общая строка «Развилки группы» читается на КАЖДОМ вопросе, группа — по
  // записи разделения. Автономию, выключенную человеком в самом чате группы
  // (своё, не от родителя), план не перебивает: это уже его разговор.
  const planGroupOf = (keys: readonly string[]) => {
    if (deps.store.getSplitDefaults().groupQuestions !== 'plan') return undefined;
    const group = groupAutoApproveFor(deps.store, keys);
    if (!group) return undefined;
    const view = chatGroupSettingsView(reader, keys);
    return view.autonomous || view.autonomousInherited ? group : undefined;
  };
  deps.chatRuns.setQuestionPlanResolver((keys) => planGroupOf(keys) !== undefined);
  // Счёт продолжений — в `state.json` (F-87): перезапуск панели не дарит новых.
  const waitCounter: WaitResumeCounter = {
    get: (conversation) => deps.store.getGroupWaitResume(conversation)?.count ?? 0,
    set: (conversation, count, group) =>
      deps.store.setGroupWaitResume(
        conversation,
        count > 0
          ? {
              count,
              parentChatId: group.parentChatId,
              groupIndex: group.groupIndex,
              at: new Date().toISOString(),
            }
          : undefined,
      ),
    delete: (conversation) => deps.store.setGroupWaitResume(conversation, undefined),
  };
  // Тот же решатель — и для ожидания, написанного текстом: вызова нет, брокер его не видит.
  const waits = new GroupWaitResume({
    groupOf: planGroupOf,
    start: (chatId, options, meta) => deps.chatRuns.start(chatId, options, meta),
    ...(deps.bridge ? { bridge: deps.bridge } : {}),
    ...(deps.gate ? { gate: deps.gate } : {}),
    ...(deps.refused ? { refused: deps.refused } : {}),
    notice: (group, answers) => recordGroupAnswerNotice(deps.store, group, answers),
    counter: waitCounter,
    log: (message, detail) => console.warn(`[group-wait] ${message}`, detail ?? ''),
  });
  deps.chatRuns.setAutoPickListener((keys, picks) => {
    escalations.fromPicks(keys, picks);
  });

  return {
    resumeWaiting: (finished) => {
      try {
        return waits.finished(finished);
      } catch (error) {
        console.warn('[group-wait] resume failed', error);
        return false;
      }
    },
    started: (keys) => waits.started(keys),
    finished: (keys, text) => {
      // Упавший ход тоже мог сказать критичное — блок в тексте и есть сказанное.
      try {
        escalations.fromReply(keys, text);
      } catch (error) {
        console.warn('[chat-escalations] notice to the root chat not recorded', error);
      }
    },
  };
}
