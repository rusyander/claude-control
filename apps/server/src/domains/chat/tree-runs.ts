import type { ModelInfo } from '@agentdeck/contracts';
import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ChatRunRegistry, RunMeta, RunSnapshot } from './ChatRunRegistry.ts';
import type { RunOptions } from './ChatRunner.ts';
import type { ProviderChatService } from '../provider-chat/ProviderChatService.ts';
import { readChat } from '../provider-chat/store.ts';
import type { ConfigProvider } from '../../providers/types.ts';

/**
 * Прогоны дерева у ЛЮБОГО провайдера — переходник, а не второе дерево.
 *
 * `TreePauseDeps.runs` — узкий интерфейс из четырёх методов (`describe`, `stop`,
 * `start`, `isRunning`), и это единственное, чем дерево, конвейер и сверка веток
 * трогают прогоны. Значит чужому CLI не нужны ни реестр прогонов, ни сессии, ни
 * брокер прав: достаточно этих четырёх поверх `ProviderChatService`. Дерево,
 * пауза, хаб и ревью при этом КОДОМ НЕ ПРАВЯТСЯ — здесь выбирается только
 * реализация, и выбирается она по ключу.
 *
 * Ключ и есть развилка: связь чужого разговора живёт под именованным ключом
 * (`codex:c1a2…`), связь Claude — под своим (uuid сессии или временный `new-…`).
 * Двоеточия во втором нет, поэтому одно дерево никогда не окажется наполовину
 * чужим, а старые связи читаются ровно как раньше.
 *
 * Чего у чужого прогона нет и не будет: продолжения «с того же места». Сессии у
 * одноразового CLI не существует, поэтому `start` — это НОВЫЙ запуск с тем же
 * заданием, и человеку это сказано словами на карточке.
 */

export interface TreeRunsDeps {
  /** Прогоны Claude — как были. */
  registry: ChatRunRegistry;
  chats: ProviderChatService;
  /** Каталог состояния панели: в нём лежат разговоры чужих провайдеров. */
  appDataDir: () => string;
  /** Провайдер по идентификатору; нет такого — прогон не запускается. */
  provider: (providerId: string) => ConfigProvider | undefined;
  /** Каталог моделей провайдера — им разворачиваются алиасы в самом прогоне. */
  models: (provider: ConfigProvider) => ModelInfo[];
  /**
   * Системная дописка запускаемого разговора (инициативы панели, планка сдачи у
   * понижённой ступени). Собирается снаружи по шапке разговора: копировать её у
   * прошлого запуска неоткуда — она нигде не хранится, а восстанавливается по
   * стадии. Пусто — прогон идёт без дописки, как чат, заведённый человеком.
   */
  systemPrefix?: (providerId: string, chatId: string) => string | undefined;
}

/** Те же четыре метода, что дерево берёт у реестра прогонов. */
export type TreeRuns = Pick<ChatRunRegistry, 'describe' | 'stop' | 'start' | 'isRunning'>;

export function createTreeRuns(deps: TreeRunsDeps): TreeRuns {
  /**
   * Снимок чужого прогона в том же виде, в каком его отдаёт реестр Claude.
   *
   * `options` заполняется тем, что у чужого разговора есть на самом деле:
   * последним вопросом человека и рабочим каталогом. Остальные поля `RunOptions`
   * (сессия, права, MCP прав) чужому CLI не принадлежат — их здесь нет вовсе, и
   * `start` их не читает.
   */
  const describeForeign = (
    key: string,
    providerId: string,
    chatId: string,
  ): RunSnapshot | undefined => {
    const chat = readChat(deps.appDataDir(), providerId, chatId);
    if (!chat) return undefined;
    const status = deps.chats.status(chatId);
    const lastAsk = [...chat.messages].reverse().find((message) => message.role === 'user');
    return {
      key,
      status: status.isRunning ? 'running' : 'done',
      options: {
        prompt: lastAsk?.content ?? '',
        cwd: chat.workdir ?? '',
        ...(chat.model ? { model: chat.model } : {}),
        ...(chat.effort ? { effort: chat.effort } : {}),
      } as RunOptions,
      meta: { ...(chat.workdir ? { projectPath: chat.workdir } : {}) } as RunMeta,
    };
  };

  return {
    describe: (chatId) => {
      const foreign = parseForeignChatKey(chatId);
      if (!foreign) return deps.registry.describe(chatId);
      return describeForeign(chatId, foreign.providerId, foreign.chatId);
    },

    stop: (chatId) => {
      const foreign = parseForeignChatKey(chatId);
      if (!foreign) return deps.registry.stop(chatId);
      return deps.chats.stop(foreign.chatId);
    },

    isRunning: (chatId, sessionId) => {
      const foreign = parseForeignChatKey(chatId);
      if (!foreign) return deps.registry.isRunning(chatId, sessionId);
      return deps.chats.status(foreign.chatId).isRunning;
    },

    /**
     * Запуск чужого прогона: тот же вопрос заново. Провайдер берётся ИЗ КЛЮЧА, а
     * не из настроек панели: продолжают дерево через часы, и активный провайдер
     * к тому моменту мог смениться — тогда запуск чужим CLI был бы запуском не
     * тем CLI.
     */
    start: (chatId, options, meta) => {
      const foreign = parseForeignChatKey(chatId);
      if (!foreign) return deps.registry.start(chatId, options, meta);
      const provider = deps.provider(foreign.providerId);
      if (!provider) return false;
      const prefix = deps.systemPrefix?.(foreign.providerId, foreign.chatId);
      const outcome = deps.chats.send(
        deps.appDataDir(),
        foreign.providerId,
        foreign.chatId,
        { text: options.prompt },
        { provider, models: deps.models(provider), ...(prefix ? { systemPrefix: prefix } : {}) },
      );
      return outcome.ok;
    },
  };
}
