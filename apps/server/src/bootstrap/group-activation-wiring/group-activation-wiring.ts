import type { ClaudePaths } from '@agentdeck/contracts';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import {
  activateEffectiveGroup,
  effectiveGroupsForRun,
} from '../../domains/chat/group-auto-pick/group-auto-pick.ts';
import { groupsActivatedNotice } from '../../domains/group-activation/group-activation.ts';
import {
  GroupLayerBlocked,
  decideRunLayer,
  runLayerNotice,
} from '../../domains/groups/run-layer/run-layer.ts';
import type { ProviderChatService } from '../../domains/provider-chat/provider-chat.ts';
import type { GroupRunActivation } from '../../domains/provider-chat/ProviderChatService/ProviderChatService.ts';
import type { AppStore } from '../../lib/app-store/store.ts';
import { getProvider } from '../../providers/registry.ts';

/**
 * Выбранная группа чата действует на КАЖДОМ старте — у обоих провайдеров.
 *
 * Раньше включение жило в маршруте отправки, и всё, что панель запускает сама
 * (дети разделения, звенья конвейера, ревью по ссылке, слово родителя), шло
 * мимо него: ребёнок родителя с явной группой работал без её правил и навыков.
 * Теперь один вопрос у реестра Claude и у службы чужих CLI; маршрут отправки
 * больше не включает выбранную группу сам — только группы, привязанные к
 * проекту.
 *
 * У Claude это тумблер его каталогов. У чужого CLI — НИКОГДА: он файлов Claude
 * не читает, тумблер ему ничего не давал, а `~/.claude` человека менялся зря.
 * Группы едут слоем на прогон (`domains/groups/run-layer/run-layer.ts`), CLI без слоя
 * получает заметку «не действует», и ни в одной ветке нет записи в Claude.
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
  deps.providerChats?.setGroupActivation((providerId, chatId, workdir) =>
    runLayer(providerId, [foreignChatKey(providerId, chatId)], workdir),
  );

  /**
   * Выбранная, привязанные к проекту и включённые для этого CLI группы — одним
   * слоем на прогон. Слоя у CLI нет — заметка «не действует»; слой не помещается
   * (Codex) — отказ прогону с причиной, ничего не обрезано.
   */
  const runLayer = (
    providerId: string,
    keys: readonly string[],
    workdir: string | undefined,
  ): GroupRunActivation | undefined => {
    const provider = getProvider(providerId);
    // Незнакомый id реестр откатывает на Claude — тумблер каталогов здесь не
    // имеет права сработать ни при каком ответе.
    if (provider.id !== providerId || providerId === 'claude') return undefined;
    try {
      const groups = effectiveGroupsForRun(toggle, keys, workdir, providerId);
      if (groups.length === 0) return undefined;
      const decision = decideRunLayer({ paths: deps.paths, store: deps.store }, provider, groups);
      const notice = { digest: decision.digest, text: runLayerNotice(decision) };
      if (decision.model === 'none') return { notice };
      if (decision.plan.refused.length > 0) {
        deps.log?.(
          `groups on ${providerId}: not delivered`,
          decision.plan.refused.map((one) => `${one.member} (${one.code})`).join(', '),
        );
      }
      const written = decision.writer.write(
        { paths: deps.paths, store: deps.store },
        decision.plan,
      );
      return {
        notice,
        ...(written ? { env: written.env } : {}),
        ...(written?.hooks?.length ? { hooks: written.hooks } : {}),
      };
    } catch (error) {
      if (error instanceof GroupLayerBlocked) return { refusal: error.message };
      deps.log?.(`group layer for ${providerId} failed`, error);
      return undefined;
    }
  };
}
