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
import {
  copyRootOf,
  type SplitConveyor,
} from '../../domains/chat/split-conveyor/split-conveyor.ts';
import type { PendingAsks } from '../../domains/chat/pending-asks/pending-asks.ts';
import { acceptSplitGroup } from '../../domains/chat/split-acceptance.ts';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { conversationKeys } from '../../lib/app-store/chat-links.ts';
import {
  sweepPathProcesses,
  sweepPathsProcesses,
  type SweepImpl,
} from '../../lib/process-tree/path-sweep.ts';
import { TESTS_RUNS_AT_DELIVERY_ENV } from '../../domains/chat/group-profile/group-profile.ts';
import type { TreePause } from '../../domains/chat/tree-pause/tree-pause.ts';
import { codeOf } from '../../lib/server-text/server-text.ts';
import type { SplitLaunchDeps } from './split-launch.ts';
import { deferredAsksOf } from './deferred-routes/deferred-store.ts';

/**
 * Метка процессов группы для добора по пути (RF-BGCD-09): профиль группы кладёт
 * её в окружение CLI всегда, потомки наследуют. Где окружение читается (Linux),
 * сирота с меткой — группы, даже подобранный субжнецом `systemd --user`.
 */
const GROUP_SWEEP: SweepImpl = { mark: TESTS_RUNS_AT_DELIVERY_ENV };

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
    /** Добор процессов копии по пути (`path-sweep.ts`); номера снятых. */
    sweepCopy?: (path: string) => Promise<number[]>;
  },
): void {
  const sweepCopy = deps.sweepCopy ?? ((path: string) => sweepPathProcesses(path, GROUP_SWEEP));
  /**
   * После паузы, «Убрать» и отмены — добор того, что группа завела в своей
   * копии и что пережило её CLI (N1b/N1c, 23.10): dev-сервер, цепочка тестов,
   * потерявшая родителя. Только своя копия группы: группа без копии работает в
   * самом проекте, и там же — стенд человека.
   */
  const sweepAfter = (paths: readonly string[], why: string): void => {
    for (const path of paths) {
      void sweepCopy(path).then((killed) => {
        if (killed.length > 0) app.log.info({ path, killed }, `${why}: copy processes swept`);
      });
    }
  };
  /** Своя копия группы по записи плана — до действия, которое меняет запись. */
  const copyOf = (parentChatId: string, index: number): string[] => {
    const record = ctx.store.getSplitPlan(parentChatId);
    const path = record ? ownCopyOf(record, groupOf(record, index)) : undefined;
    return path ? [path] : [];
  };
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
        const copy = copyOf(request.params.parent, found.index);
        const { chatIds } = found.conveyor.pause(request.params.parent, found.index);
        // Идущий ход и ждущий процесс с фоном — оба (N1a): `stopConversation`.
        const body: SplitGroupPaused = { index: found.index, ...stopEach(chatIds) };
        sweepAfter(copy, 'split pause');
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
        const plan = ctx.store.getSplitPlan(request.params.parent);
        const chatId = plan ? groupOf(plan, found.index)?.chatId : undefined;
        const copy = copyOf(request.params.parent, found.index);
        found.conveyor.dropGroup(request.params.parent, found.index);
        // Убранная группа больше не на паузе, и сторож пробуждений её не держит:
        // процесс, переживший паузу (снятие не подтвердилось), гасится здесь.
        if (chatId) stopEach([chatId]);
        sweepAfter(copy, 'split drop');
        // Убранная группа закрыта насовсем — её D-n отзываются, как при отмене
        // плана: иначе позднее «Разрешить» будило бы группу, которую человек
        // убрал, а сообщение в Telegram ждало бы ответа (RF-DL-10).
        const parent = request.params.parent;
        deferredAsksOf(ctx).withdraw(
          (scope) =>
            scope.kind === 'group' &&
            scope.parentChatId === parent &&
            scope.groupIndex === found.index,
        );
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

  // «Принять» доставленную группу, «Отметить готовой» остановившуюся и «Снять
  // отметку» (`accepted: false`) — ручное решение человека; запись плана
  // разделения держит отметку, отмеченная готовой отпускает ждавших её.
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
          undefined,
          (record) => found.conveyor.afterMarkedDone(record),
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
      // копии своим cwd, и «Убрать копию» спотыкалась о них (F4c). Процессы
      // разговоров групп — и с фоном — гасит остановка выше (N1a); здесь —
      // прочие простаивающие в копиях, потом добор по пути копии.
      for (const path of paths) void deps.runs.livePool.closeIdleIn(path);
      sweepAfter(paths, 'split cancel');
      // Вопросы закрытых групп больше никто не ждёт — иначе вкладка звала бы
      // «агент ждёт ответа» по разговору отменённого плана.
      // И законченные прогоны их ходов уходят из буфера догона: хвост с вопросом
      // вкладка после F5 подхватила бы и снова позвала (живая приёмка 09.10).
      for (const chatId of chatIds) {
        const keys = [chatId, ...conversationKeys(ctx.store.getChatLinks(), chatId)];
        deps.asks?.forget(keys);
        for (const key of keys) deps.runs.discardFinished(key);
      }
      // Отложенные вопросы D-n отменённого плана отзываются: продолжать нечего,
      // а неиспользованное разрешение не должно дожить до нового плана.
      const parent = request.params.parent;
      deferredAsksOf(ctx).withdraw(
        (scope) => scope.kind === 'group' && scope.parentChatId === parent,
      );
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
  if (deps.runs.isRunning(key)) return deps.runs.stop(key);
  // Хода нет, а процесс ждёт следующего — с фоновой задачей, чей конец его
  // разбудит (N1a, 23.10: группа на паузе закоммитила и завела копию). Гасим и его.
  return deps.runs.closeLive(key);
}

/**
 * Своя копия группы — путь, которого нет ни у проекта, ни у верха копий: только
 * её можно мести по пути (то же правило, что у копий отменённого плана).
 */
/**
 * Группа записи по её номеру `index`, не по позиции в массиве (F-83): так её ищут все остальные
 * места; позиция совпадает с номером лишь пока группы не переставляют и не убирают из записи.
 */
export function groupOf<G extends { index: number }>(
  record: { groups: readonly G[] },
  index: number,
): G | undefined {
  return record.groups.find((group) => group.index === index);
}

export function ownCopyOf(
  record: Pick<SplitPlanRecord, 'projectPath' | 'copyRoot'>,
  group: { path?: string; cleaned?: unknown } | undefined,
): string | undefined {
  if (!group?.path || group.cleaned) return undefined;
  const norm = (value: string): string =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const within = (path: string, dir: string): boolean =>
    norm(path) === norm(dir) || norm(path).startsWith(`${norm(dir)}/`);
  if (within(group.path, record.projectPath) || within(group.path, copyRootOf(record))) {
    return undefined;
  }
  return group.path;
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
 * Разговор принадлежит группе на паузе — по любому его ключу (`new-…`, sessionId).
 * Пауза — решение человека («Стоп» в чате или «Пауза» в хабе), и снимает её только
 * он: «Продолжить» или своё сообщение в чат группы. Самостоятельные старты — повтор
 * упавшего хода, слово родителя (`agentdeck:tell`) — спрашивают здесь и группу
 * не будят (живое наблюдение 19.10, R13).
 */
export function pausedGroupOf(
  store: {
    getChatLink: (key: string) => ChatLink | undefined;
    getChatLinks: () => Record<string, ChatLink>;
  },
  conveyor: Pick<SplitConveyor, 'isPaused'>,
): (chatId: string) => boolean {
  return (chatId) =>
    [chatId, ...conversationKeys(store.getChatLinks(), chatId)].some((key) => {
      const link = store.getChatLink(key);
      return Boolean(link && conveyor.isPaused(link));
    });
}

/**
 * Разговор группы разделения в стоящем дереве («Остановить всё», 23.10): сторож
 * пробуждений держит его так же, как группу на паузе. Только группы: прочие
 * разговоры дерева пробуждение не держит — их ход начат CLI, а не панелью.
 */
export function treePausedGroupOf(
  store: {
    getChatLink: (key: string) => ChatLink | undefined;
    getChatLinks: () => Record<string, ChatLink>;
  },
  tree: Pick<TreePause, 'isPaused'>,
): (chatId: string) => boolean {
  return (chatId) => {
    const keys = [chatId, ...conversationKeys(store.getChatLinks(), chatId)];
    const group = keys.some((key) => store.getChatLink(key)?.groupIndex !== undefined);
    return group && keys.some((key) => tree.isPaused(key));
  };
}

/**
 * Добор процессов своих копий групп по ключам снятых разговоров (пауза дерева):
 * одним снимком на все копии. Номера снятых.
 */
export function sweepGroupCopies(
  store: {
    getChatLink: (key: string) => ChatLink | undefined;
    getSplitPlan: (parentChatId: string) => SplitPlanRecord | undefined;
  },
  keys: readonly string[],
  sweep: (dirs: readonly string[]) => Promise<number[]> = (dirs) =>
    sweepPathsProcesses(dirs, GROUP_SWEEP),
): Promise<number[]> {
  const copies = new Set<string>();
  for (const key of keys) {
    const link = store.getChatLink(key);
    if (!link?.parentChatId || link.groupIndex === undefined) continue;
    const record = store.getSplitPlan(link.parentChatId);
    const copy = record ? ownCopyOf(record, groupOf(record, link.groupIndex)) : undefined;
    if (copy) copies.add(copy);
  }
  return copies.size > 0 ? sweep([...copies]) : Promise.resolve([]);
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
