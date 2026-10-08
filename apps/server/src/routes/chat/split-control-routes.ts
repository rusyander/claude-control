import type { FastifyInstance, FastifyReply } from 'fastify';
import { foreignChatKey, parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type {
  SplitGroupContinued,
  SplitGroupPaused,
  SplitGroupRechecked,
  SplitGroupResumed,
  SplitPlanCancelled,
} from '@agentdeck/contracts/chat-handoff';
import type { ServerContext } from '../../context.ts';
import type { StopOutcome } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { SplitConveyor } from '../../domains/chat/split-conveyor/split-conveyor.ts';
import type { PendingAsks } from '../../domains/chat/pending-asks/pending-asks.ts';
import { acceptSplitGroup } from '../../domains/chat/split-acceptance.ts';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import { conversationKeys } from '../../lib/app-store/chat-links.ts';
import { codeOf } from '../../lib/server-text/server-text.ts';
import type { SplitLaunchDeps } from './split-launch.ts';

/**
 * Управление одной группой разделения из хаба (журнал 81, 89): пауза,
 * продолжение с паузы и «запустить сейчас» из очереди.
 *
 * Пауза сперва пишет запись, потом останавливает прогон: конец остановленного
 * хода застаёт группу уже на паузе и не пишет ей «сбой» (`onChainEnded` паузу
 * не трогает). Место под потолком пауза держит (живой прогон 29.09).
 *
 * Потолок и лимит подписки — отказ 409 с числами; клиент спрашивает человека и
 * повторяет с `force` — решение «сверх потолка» за человеком, а не за панелью.
 */
export function registerSplitControlRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: Pick<SplitLaunchDeps, 'runs' | 'providerChats'> & {
    conveyor?: SplitConveyor;
    /** Записанные вопросы деревьев: отмена плана снимает вопросы его групп. */
    asks?: Pick<PendingAsks, 'forget'>;
    /** «Перепроверить MR» доставленной группы (`split-recheck.ts`). */
    recheckMr?: (parentChatId: string, index: number) => Promise<SplitGroupRechecked>;
  },
): void {
  /** Номер группы из тела; нет конвейера или номера — ответ уже отправлен. */
  const target = (
    reply: FastifyReply,
    raw: unknown,
  ): { conveyor: SplitConveyor; index: number } | undefined => {
    if (!deps.conveyor) {
      void reply
        .code(404)
        .send({ message: 'Конвейер уровней выключен', messageCode: 'split-conveyor-off' });
      return undefined;
    }
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0) {
      void reply
        .code(400)
        .send({ message: 'Нужен номер группы', messageCode: 'split-group-number-required' });
      return undefined;
    }
    return { conveyor: deps.conveyor, index };
  };
  const refuse = (reply: FastifyReply, error: unknown) =>
    reply.code(409).send({ message: (error as Error).message, ...codeOf(error) });

  /**
   * Остановить прогоны разговора группы — у Claude и у чужого CLI. Разговор не
   * остановлен, пока жив хоть один его процесс: неподтверждённый исход по любому
   * ключу весит больше «остановлено» по другому (F-145).
   */
  const stopConversation = (chatId: string): StopOutcome => {
    const outcomes = [chatId, ...conversationKeys(ctx.store.getChatLinks(), chatId)].map((key) =>
      stopChatKey(deps, key),
    );
    if (outcomes.includes('unconfirmed')) return 'unconfirmed';
    return outcomes.includes('stopped') ? 'stopped' : 'absent';
  };
  /** Исходы остановки разговоров — числами для ответа человеку. */
  const stopEach = (chatIds: readonly string[]): { stopped: number; unconfirmed: number } => {
    const outcomes = chatIds.map((chatId) => stopConversation(chatId));
    return {
      stopped: outcomes.filter((outcome) => outcome === 'stopped').length,
      unconfirmed: outcomes.filter((outcome) => outcome === 'unconfirmed').length,
    };
  };

  app.post<{ Params: { parent: string }; Body: { index?: number } }>(
    '/api/chat/split/:parent/pause',
    (request, reply) => {
      const found = target(reply, request.body?.index);
      if (!found) return reply;
      try {
        const { chatIds } = found.conveyor.pause(request.params.parent, found.index);
        const body: SplitGroupPaused = { index: found.index, ...stopEach(chatIds) };
        return body;
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  app.post<{ Params: { parent: string }; Body: { index?: number; force?: boolean } }>(
    '/api/chat/split/:parent/resume-paused',
    (request, reply) => {
      const found = target(reply, request.body?.index);
      if (!found) return reply;
      try {
        const outcome = found.conveyor.resumePaused(
          request.params.parent,
          found.index,
          request.body?.force === true,
        );
        const body: SplitGroupResumed = { index: found.index, outcome };
        return body;
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  app.post<{ Params: { parent: string }; Body: { index?: number; force?: boolean } }>(
    '/api/chat/split/:parent/start-now',
    async (request, reply) => {
      const found = target(reply, request.body?.index);
      if (!found) return reply;
      try {
        return await found.conveyor.startNow(
          request.params.parent,
          found.index,
          request.body?.force === true,
        );
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  // Группа, оборванная до своего чата (живой прогон 29.09): «Завести заново» в
  // её копии или «Убрать». Продолжать ей нечего — сессии нет.
  app.post<{ Params: { parent: string }; Body: { index?: number; force?: boolean } }>(
    '/api/chat/split/:parent/restart-group',
    async (request, reply) => {
      const found = target(reply, request.body?.index);
      if (!found) return reply;
      try {
        await found.conveyor.restartGroup(
          request.params.parent,
          found.index,
          request.body?.force === true,
        );
        return { index: found.index };
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  app.post<{ Params: { parent: string }; Body: { index?: number } }>(
    '/api/chat/split/:parent/drop-group',
    (request, reply) => {
      const found = target(reply, request.body?.index);
      if (!found) return reply;
      try {
        found.conveyor.dropGroup(request.params.parent, found.index);
        return { index: found.index };
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  // «Продолжить» группу, остановившуюся недоделанной (владелец 05.10): сбой,
  // кончившиеся повторы, ход без вердикта ревью. Потолок — отказ с числами.
  app.post<{ Params: { parent: string }; Body: { index?: number; force?: boolean } }>(
    '/api/chat/split/:parent/continue-group',
    (request, reply) => {
      const found = target(reply, request.body?.index);
      if (!found) return reply;
      try {
        const outcome = found.conveyor.continueGroup(
          request.params.parent,
          found.index,
          request.body?.force === true,
        );
        const body: SplitGroupContinued = { index: found.index, outcome };
        return body;
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  // «Перепроверить MR» доставленной группы: конфликты, замечания, конвейер,
  // готовность задач — группа правит найденное и доставляет заново.
  app.post<{ Params: { parent: string }; Body: { index?: number } }>(
    '/api/chat/split/:parent/recheck',
    async (request, reply) => {
      const found = target(reply, request.body?.index);
      if (!found) return reply;
      if (!deps.recheckMr) {
        return reply
          .code(404)
          .send({ message: 'Конвейер уровней выключен', messageCode: 'split-conveyor-off' });
      }
      try {
        return await deps.recheckMr(request.params.parent, found.index);
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  // «Принять» доставленную группу и «Снять отметку» (`accepted: false`) —
  // ручная приёмка человека; запись плана разделения держит отметку.
  app.post<{ Params: { parent: string }; Body: { index?: number; accepted?: boolean } }>(
    '/api/chat/split/:parent/accept',
    (request, reply) => {
      const found = target(reply, request.body?.index);
      if (!found) return reply;
      try {
        return acceptSplitGroup(
          {
            get: (parent) => ctx.store.getSplitPlan(parent),
            set: (record) => ctx.store.setSplitPlan(record),
          },
          {
            parentChatId: request.params.parent,
            index: found.index,
            accepted: request.body?.accepted !== false,
          },
        );
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  // «Убрать» строку «разрешено автоматически» в хабе (аудит 25.09, L51):
  // человек увидел, что прошло без него, — отметки группы стираются.
  app.post<{ Params: { parent: string }; Body: { index?: number } }>(
    '/api/chat/split/:parent/auto-notices/dismiss',
    (request, reply) => {
      const index = Number(request.body?.index);
      if (!Number.isInteger(index) || index < 0) {
        return reply
          .code(400)
          .send({ message: 'Нужен номер группы', messageCode: 'split-group-number-required' });
      }
      const plan = ctx.store.getSplitPlan(request.params.parent);
      const group = plan?.groups.find((entry) => entry.index === index);
      if (!plan || !group) {
        return reply
          .code(404)
          .send({ message: 'Группа не найдена', messageCode: 'split-group-not-found' });
      }
      const dismissed = group.autoNotices?.length ?? 0;
      delete group.autoNotices;
      ctx.store.setSplitPlan(plan);
      return { index, dismissed };
    },
  );

  // «Отменить план» (владелец, 25.09.2026): запись — первой, прогоны — потом,
  // как у паузы: конец остановленного хода застаёт группу уже закрытой.
  app.post<{ Params: { parent: string } }>('/api/chat/split/:parent/cancel', (request, reply) => {
    if (!deps.conveyor) {
      return reply
        .code(404)
        .send({ message: 'Конвейер уровней выключен', messageCode: 'split-conveyor-off' });
    }
    try {
      const { chatIds, cancelled, paths } = deps.conveyor.cancel(request.params.parent);
      const body: SplitPlanCancelled = { ...stopEach(chatIds), cancelled, chatIds };
      // Процессы CLI, ждущие следующего хода в копиях отменённого плана, держат
      // копии своим cwd, и «Убрать копию» спотыкалась о них (F4c). Занятые ходом
      // или фоном остаются: их прогон гасит остановка выше или человек.
      for (const path of paths) void deps.runs.livePool.closeIdleIn(path);
      // Вопросы закрытых групп больше никто не ждёт — иначе вкладка звала бы
      // «агент ждёт ответа» по разговору отменённого плана.
      for (const chatId of chatIds) {
        deps.asks?.forget([chatId, ...conversationKeys(ctx.store.getChatLinks(), chatId)]);
      }
      return body;
    } catch (error) {
      return refuse(reply, error);
    }
  });
}

/**
 * Остановить прогон по одному ключу: чужой CLI — своим хранилищем, Claude —
 * реестром. Исход, а не «да/нет»: `unconfirmed` — процесс жив и не снят (F-145).
 */
export function stopChatKey(
  deps: Pick<SplitLaunchDeps, 'runs' | 'providerChats'>,
  key: string,
): StopOutcome {
  const foreign = parseForeignChatKey(key);
  if (foreign) return deps.providerChats.stop(foreign.chatId) ? 'stopped' : 'absent';
  return deps.runs.isRunning(key) ? deps.runs.stop(key) : 'absent';
}

/**
 * «Стоп» человека в чате группы (журнал 89c) — пауза группы, а не «сбой»:
 * слушатель `ChatRunRegistry.setHumanStopListener`. Разбор паузы не знает —
 * его группы ещё не заведены.
 */
export function pauseOnHumanStop(
  store: { getChatLink: (key: string) => ChatLink | undefined },
  conveyor: Pick<SplitConveyor, 'pauseByLink'>,
): (keys: readonly string[]) => void {
  return (keys) => {
    for (const key of keys) {
      const link = store.getChatLink(key);
      if (link && link.stage !== 'triage' && conveyor.pauseByLink(link)) return;
    }
  };
}

/**
 * «Стоп» человека в чате группы ЧУЖОГО CLI — та же пауза (открытый вопрос WP9e):
 * слушатель `ProviderChatService.setHumanStopListener`. Ключ у чужого разговора
 * один — `<провайдер>:<чат>`, под ним и лежит связь группы.
 */
export function pauseOnForeignStop(
  store: { getChatLink: (key: string) => ChatLink | undefined },
  conveyor: Pick<SplitConveyor, 'pauseByLink'>,
): (providerId: string, chatId: string) => void {
  const pause = pauseOnHumanStop(store, conveyor);
  return (providerId, chatId) => pause([foreignChatKey(providerId, chatId)]);
}
