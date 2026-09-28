import type { ChatEvent } from '../domains/chat/chat-events.ts';
import type { ChatRunRegistry } from '../domains/chat/ChatRunRegistry.ts';
import {
  chatGroupSettingsView,
  rootChatOf,
  storeTreeReader,
} from '../domains/chat/chat-autonomy.ts';
import { createEscalations } from '../domains/chat/escalations.ts';
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
}

export interface ChatAutonomyWiring {
  /** Конец хода любого провайдера: блоки замечаний из ответа ребёнка. */
  finished: (keys: readonly string[], text: string) => void;
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
  deps.chatRuns.setAutoPickListener((keys, picks) => {
    escalations.fromPicks(keys, picks);
  });

  return {
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
