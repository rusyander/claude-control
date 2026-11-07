import { useConversationCli } from '@entities/ChatCli';
import { useModelCatalog } from '@entities/ModelCatalog';
import { useProviders } from '@entities/Provider';

/**
 * CLI разговора и каталог его моделей для шапки чата (W3-17a). Новый разговор идёт активным
 * провайдером, начатый — своим CLI (книга чата на сервере), и шапка предлагает модели ЭТОГО CLI:
 * разговор Codex при активном Claude — каталог Codex, новый чат при активном Qwen — каталог Qwen,
 * а не алиасы и модели Claude. `cli` не известен (ответы в пути) — `undefined`, шапка как у Claude.
 */
export function useChatCliModels(conversationId: string | undefined, turnEnded: boolean) {
  const providers = useProviders();
  const cli = useConversationCli(conversationId, providers.data?.active, turnEnded);
  const catalog = useModelCatalog(cli);
  return { cli, models: catalog.data?.models };
}
