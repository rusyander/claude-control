import { join } from 'node:path';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { UNUSED_HEAVY_TOOLS } from '../../domains/chat/initiative/initiative.ts';
import { appendLimitRun } from '../../domains/chat/limit-journal/limit-journal.ts';
import { appendLoweredRun } from '../../domains/chat/lowered-journal/lowered-journal.ts';
import { appendRunInput, moveRunInputs } from '../../domains/chat/run-input/run-input.ts';
import { localLayerRun } from '../../domains/local-layer/local-layer.ts';
import { chatContourRoutes } from '../../domains/platform/routing/core-contour.ts';
import { createCoreCaller } from '../../domains/core-ask/core-ask.ts';
import { createCoreChatBook } from '../../domains/chat/core-run/core-chat-book.ts';
import { createCoreChatPort } from '../../domains/chat/core-run/core-chat-port.ts';
import { CoreChatRun } from '../../domains/chat/core-run/core-run.ts';
import type {
  CoreChatRunDeps,
  CorePermissionDesk,
} from '../../domains/chat/core-run/core-run.types.ts';
import { getActiveProviderId } from '../../providers/registry.ts';
import { coreHomeOf } from '../../lib/hop-recorder.mjs';

/**
 * Проводка чата Claude (этап 10, зона chat): реестр прогонов, права сессии, лёгкие чаты вопросов
 * и то, что реестр пишет на диск. Вынесена из `runtime.ts`, чтобы зона, переводящая чат на ядро,
 * правила один файл. Связи с группами (дети разделения, ворота ветки, остывшие сессии) остаются
 * в `runtime.ts` — их ведёт зона групп. Поведение то же: сеттеры реестра — простые присваивания,
 * и порядок их вызова до первого прогона ничего не решает.
 */
export interface ChatWiring {
  chatRuns: ChatRunRegistry;
  chatSession: ChatSession;
}

/** Слой панели разговору не-Claude CLI (W3-17a); runtime отдаёт его позже — зовётся при ходе. */
export interface ChatWiringExtra {
  foreignCarry?: CoreChatRunDeps['foreignCarry'];
}

export function wireChat(ctx: ServerContext, extra: ChatWiringExtra = {}): ChatWiring {
  /**
   * Ход чата Claude идёт задачей ядра (этап 10, F2, проход 3): своего процесса CLI у чата
   * панели нет. Ядро не запущено или отказало — ошибка хода с причиной, без отката на прежний
   * исполнитель. Карточки права — тот же брокер `ChatSession`, он заводится ниже.
   */
  const book = createCoreChatBook(join(ctx.location.paths.appData, 'core-chat-book.json'));
  const port = createCoreChatPort(createCoreCaller(() => coreHomeOf()));
  // Брокер `ChatSession` заводится ниже, поверх реестра; карточки идут к нему уже после сборки.
  const desk: CorePermissionDesk = {
    request: (runId, card) => chatSession.requestPermission({ runId, ...card }),
    // Ответ человека записало ядро (команда браузера): карточка брокера снимается им же.
    settle: (runId, toolUseId, reply) => void chatSession.decidePermission(runId, toolUseId, reply),
  };
  // Маршрут контура — по галочке CLI разговора: Claude «Чат», другой CLI своя `foreign:<cli>` (а при
  // обязательном контуре всегда), свежим на каждую задачу. CLI разговора (W3-17a): новый —
  // активный провайдер, начатый — свой.
  const routes = (asked: string, cli: string) => chatContourRoutes(ctx.store, cli, asked);
  const activeCli = () => getActiveProviderId(ctx.store);
  const foreignCarry = extra.foreignCarry;
  const chatRuns = new ChatRunRegistry(
    () =>
      new CoreChatRun({
        port,
        book,
        desk,
        routes,
        activeCli,
        ...(foreignCarry ? { foreignCarry } : {}),
      }),
  );
  /**
   * Права и автоподтверждение чатов — один объект на сервер, а не на маршрут:
   * продолжение в чистой сессии заводит прогон мимо маршрута отправки, и
   * тумблеры закрытого разговора должны достаться новому. Тумблеры лежат и на
   * диске: родитель без прогона после перезапуска отдаёт их детям разделения.
   */
  const chatSession = new ChatSession(chatRuns, ctx.location.paths.appData);
  /**
   * Дерево чатов переживает смену ключа. Разделение заводит чат под временным
   * `new-<ts>-<n>`, а настоящий `sessionId` Claude Code выдаёт уже в прогоне —
   * и в списке чат появляется под ним. Без переноса связи ветвь дерева обрывалась
   * бы ровно в момент, когда чат становится настоящим.
   */
  chatRuns.setSessionListener((chatId, sessionId, from) => {
    ctx.store.linkChatSession(chatId, sessionId, from);
    // Вход первого хода записан под временным ключом — едет за настоящим (U8).
    try {
      moveRunInputs(ctx.location.paths.appData, chatId, sessionId);
    } catch {
      // Сверка входа не главнее связи разговора.
    }
  });
  chatRuns.setFirstEditListener((keys, at) => ctx.store.markChatFirstEdit(keys, at));
  // Тяжёлые неиспользуемые схемы (Artifact, Workflow, ScheduleWakeup) — флагом каждому прогону Claude.
  chatRuns.setDeniedToolsResolver(() =>
    ctx.store.getSettings().chatLeanTools ? UNUSED_HEAVY_TOOLS : [],
  );
  // Локальный слой проекта (`.agent/local-layer/`): сломанный слой не мешает
  // чату — прогон идёт на командном слое, как без него.
  chatRuns.setLocalLayerResolver((cwd) => {
    try {
      return localLayerRun(cwd);
    } catch {
      return undefined;
    }
  });
  /**
   * Журнал понижённых прогонов: чем вели и видела ли панель проверки. Путь до
   * каталога данных знает bootstrap, а не реестр, — тем же приёмом, что и
   * уведомления.
   */
  chatRuns.setLoweredJournal((record) => appendLoweredRun(ctx.location.paths.appData, record));
  chatRuns.setLimitJournal((record) => appendLimitRun(ctx.location.paths.appData, record));
  // «Что получил агент» (U8): под настоящим ключом, если он уже известен.
  chatRuns.setInputJournal((keys, record) =>
    appendRunInput(ctx.location.paths.appData, keys.at(-1) ?? '', record),
  );
  return { chatRuns, chatSession };
}
