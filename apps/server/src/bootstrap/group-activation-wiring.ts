import type { ClaudePaths } from '@agentdeck/contracts';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ChatRunRegistry } from '../domains/chat/ChatRunRegistry.ts';
import { activateEffectiveGroup } from '../domains/chat/group-auto-pick.ts';
import { groupsActivatedNotice } from '../domains/group-activation.ts';
import type { ProviderChatService } from '../domains/provider-chat.ts';
import type { AppStore } from '../lib/app-store/store.ts';

/**
 * Выбранная группа чата включается на КАЖДОМ старте — у обоих провайдеров.
 *
 * Раньше включение жило в маршруте отправки, и всё, что панель запускает сама
 * (дети разделения, звенья конвейера, ревью по ссылке, слово родителя), шло
 * мимо него: ребёнок родителя с явной группой работал без её правил и навыков.
 * Теперь один вопрос у реестра Claude и у службы чужих CLI; маршрут отправки
 * больше не включает выбранную группу сам — только группы, привязанные к
 * проекту.
 */
export interface GroupActivationWiringDeps {
  store: AppStore;
  paths: ClaudePaths;
  backupDir?: string;
  chatRuns: Pick<ChatRunRegistry, 'setGroupActivation'>;
  providerChats?: Pick<ProviderChatService, 'setGroupActivation'>;
  log?: (message: string, error: unknown) => void;
}

export function wireGroupActivation(deps: GroupActivationWiringDeps): void {
  const toggle = {
    paths: deps.paths,
    store: deps.store,
    ...(deps.backupDir ? { backupDir: deps.backupDir } : {}),
  };
  const activate = (keys: readonly string[], cwd: string | undefined): string | undefined => {
    try {
      return activateEffectiveGroup(toggle, keys, cwd);
    } catch (error) {
      deps.log?.('chosen group activation failed', error);
      return undefined;
    }
  };

  // Заметка — та же, что у группы проекта: включение задумано, но без строки в
  // ленте человек не понял бы, откуда у агента новые правила.
  deps.chatRuns.setGroupActivation((keys, cwd) => {
    const name = activate(keys, cwd);
    return name ? groupsActivatedNotice([name]) : undefined;
  });
  // Ленты у чужого CLI панель не пишет: факт виден на странице «Наборы».
  deps.providerChats?.setGroupActivation((providerId, chatId, workdir) => {
    activate([foreignChatKey(providerId, chatId)], workdir);
  });
}
