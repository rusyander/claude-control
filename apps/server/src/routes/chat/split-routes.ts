import type { FastifyInstance } from 'fastify';
import {
  parseSplitProposal,
  SPLIT_SYSTEM_PROMPT,
  type TaskSplitResult,
} from '@agentdeck/contracts/task-split';
import { cascadeSystemPrompt, parseAssignments } from '@agentdeck/contracts/model-cascade';
import { cascadeCeilingFor } from '../../domains/model-cascade.ts';
import type { ServerContext } from '../../context.ts';
import type { SplitConveyor } from '../../domains/chat/split-conveyor.ts';
import type { SplitOverlap } from '../../domains/chat/split-overlap.ts';
import type { SplitReview } from '../../domains/chat/split-review.ts';
import { splitPlanRunning, type SplitReviewRefusal } from '@agentdeck/contracts/chat-handoff';
import { checkProjectDir } from '../../domains/projects.ts';
import { createSplitLauncher, type SplitLaunchDeps } from './split-launch.ts';
import { registerSplitControlRoutes, stopChatKey } from './split-control-routes.ts';
import { codeOf, coded } from '../../lib/server-text.ts';
import { removeGroupCopy } from '../../domains/chat/split-cleanup.ts';
import { splitRootOf } from '../../domains/project-git.ts';
import { conversationKeys } from '../../lib/app-store/chat-links.ts';
import {
  atlassianTicketTracker,
  type SplitTicketTracker,
} from '../../domains/chat/split-ticket-tracker.ts';
import { IntegrationError } from '../../domains/integrations/errors.ts';
import { fail } from '../integrations/shared.ts';
import type { PendingAsks } from '../../domains/chat/pending-asks.ts';

/**
 * Разделение списка задач по нескольким чатам — одним запросом.
 *
 * Почему эндпоинт, а не цикл в браузере: «завести копию → запустить прогон»
 * должно быть одной последовательностью с одним порядком и одним разбором
 * отказов. Циклом на клиенте это существовало бы дважды (панель и телефон) и
 * разошлось бы на первой же правке; тестом такое не покроешь вовсе.
 *
 * Клиенту остаётся ровно одно — открыть вкладки на путях, которые вернул ответ.
 *
 * Провайдер решает только ВИД чата: у Claude это разговор реестра прогонов, у
 * чужого CLI — разговор его собственного хранилища. Копии и ветки одни и те же:
 * git не знает, кто в них будет работать.
 *
 * При включённом подборе (Т1) группы не стартуют разом: сначала в корне идёт
 * разбор на потолке, и только по его итогу конвейер (`SplitConveyor`) заводит
 * копии — порциями, с ожиданиями предшественников и вопросов человеку. Ответ
 * маршрута тогда несёт `triage`, а не чаты: их ещё нет. Сам запуск групп тот же
 * (`createSplitLauncher`) — конвейер лишь решает, КОГДА его позвать.
 */
export function registerChatSplitRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: Omit<SplitLaunchDeps, 'log'> & {
    /** Конвейер уровней; нет — разделение идёт как до Т1, разом. */
    conveyor?: SplitConveyor;
    /** Сверка веток после работы (Т6); нет — кнопка в хабе отвечает 404. */
    overlap?: SplitOverlap;
    /** Решения по ревью MR (Т7); нет — карточка решения отвечает 404. */
    review?: SplitReview;
    /** Трекер для тикетов групп (L277); по умолчанию — Jira из интеграций. */
    tracker?: SplitTicketTracker;
    /** Записанные вопросы деревьев: отмена плана снимает вопросы его групп. */
    asks?: Pick<PendingAsks, 'forget'>;
  },
): void {
  const tracker = deps.tracker ?? atlassianTicketTracker(ctx);

  /** Родители, чей перезапуск ещё заводит копии (находка 19: ответ уходит раньше). */
  const relaunching = new Set<string>();

  app.post<{
    Body: {
      /** Каталог проекта, из которого делят. Обязателен: копии заводятся в нём. */
      projectPath?: string;
      /** Предложение агента — ровно то, что было в блоке ответа. */
      proposal?: unknown;
      /** Запускать прогоны сразу; false — только завести чаты с готовым заданием. */
      startRuns?: boolean;
      allowEdits?: boolean;
      model?: string;
      effort?: string;
      /**
       * Разговор, в котором человек согласился на разделение. Нужен ради дерева
       * в списке чатов: пять чатов, приехавших из одной просьбы, должны висеть
       * ветвями под ней, а не лежать в списке вперемешку с остальными.
       */
      parentChatId?: string;
      /**
       * Ручные замены с карточки: номер группы → выбранные человеком модель и
       * глубина. Отдельным полем от предложения намеренно — см.
       * `parseAssignments`: просьба агента действует только вверх, выбор
       * человека в обе стороны, и внутри одного объекта их не различить.
       */
      assignments?: unknown;
    };
  }>('/api/chat/split', async (request, reply) => {
    // Тумблера автоподтверждения в теле запроса нет намеренно: он живёт на
    // конкретном разговоре и взводится тем же модулем, что потом принимает
    // запросы прав. Дети получают его наследованием от родителя (лаунчер).
    const { projectPath, startRuns, allowEdits, model, effort, parentChatId } = request.body ?? {};

    const problem = checkProjectDir(String(projectPath ?? ''));
    if (problem) return reply.code(400).send({ message: problem });

    // Разбор тот же самый, которым панель узнаёт блок в ответе: два понимания
    // формата — два разных набора заведённых веток при одном и том же тексте.
    const proposal = parseSplitProposal(request.body?.proposal);
    if (!proposal) {
      return reply.code(400).send({
        message: 'Разделение не разобрано: нужны минимум две группы с задачами',
        messageCode: 'split-proposal-invalid',
      });
    }

    // Верх репозитория, а не каталог, куда агент ушёл `cd` (см. `splitRootOf`):
    // из подкаталога группы стартовали бы без копий, все в одном месте.
    const root = await splitRootOf(projectPath as string);
    const wantRuns = startRuns !== false;
    const launcher = createSplitLauncher(
      ctx,
      { ...deps, log: app.log },
      {
        projectPath: root,
        // Настройки — по пути, который открыл человек, а не по верху репозитория (m6).
        settingsPath: projectPath as string,
        ...(parentChatId ? { parentChatId } : {}),
        ...(allowEdits !== undefined ? { allowEdits } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(request.body?.assignments !== undefined
          ? { assignments: request.body.assignments }
          : {}),
      },
    );

    // Разделение этого разговора ещё идёт — новое «Разделить» его молча не
    // перекрывает (находка 12, решение владельца 25.09.2026): ни вторым разбором
    // поверх плана, ни «только завести чаты» веером рядом с работающими группами.
    // В отказе — ключ записи: по нему панель предлагает «Отменить план». Проверка
    // и `begin` идут без `await` между ними: два запроса разом не проскочат оба.
    const running = launcher.parentKey ? ctx.store.getSplitPlan(launcher.parentKey) : undefined;
    if (running && splitPlanRunning(running.groups)) {
      return reply.code(409).send({
        message: 'Разделение этого разговора ещё идёт — дождитесь конца групп или отмените план',
        messageCode: 'split-plan-running',
        parentChatId: running.parentChatId,
      });
    }

    // Новое разделение того же разговора: звенья прошлого плана снимаются
    // (находка F5 живого прогона 25.09). Запись плана ключуется родителем, и
    // старая группа с тем же номером читалась бы группой НОВОГО плана: хаб
    // вклеивал прошлые чаты в новые строки («остановлена: план отменён»), а
    // конец их хода закрывал бы новую группу. Снятое звено остаётся в списке
    // под родителем, с меткой `retired`; прогоны не гасятся — это уже разговоры
    // человека, а не работа плана.
    if (launcher.parentKey) retirePreviousSplit(ctx, launcher.parentKey);

    // Разделили — значит этот разговор своё решение принял. Предлагать ему то
    // же самое в каждом следующем прогоне не помощь, а навязчивость.
    if (parentChatId) deps.runs.muteSplit(parentChatId);

    // Уровни (Т1): подбор включён, прогоны нужны, родитель известен — разбор
    // идёт первым, группы заводит конвейер. «Только завести чаты» уровней не
    // получает: человек просил заготовки, а не работу.
    if (deps.conveyor && launcher.planned && wantRuns && launcher.parentKey) {
      const manual = parseAssignments(request.body?.assignments);
      const { result } = await deps.conveyor.begin({
        // Запись конвейера ключуется ТЕМ ЖЕ ключом, что и связи: у чужого CLI
        // именованным. Иначе конец цепочки группы (`onChainEnded` смотрит в
        // связь) и хаб родителя искали бы запись по разным адресам.
        parentChatId: launcher.parentKey,
        // Запись помнит оба пути (m6): открытый человеком — ключ его настроек и
        // очереди, верх репозитория — откуда заводить и где убирать копии.
        projectPath: projectPath as string,
        copyRoot: root,
        proposal,
        request: {
          ...(allowEdits !== undefined ? { allowEdits } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(manual.size > 0
            ? { assignments: Object.fromEntries([...manual].map(([i, a]) => [String(i), a])) }
            : {}),
        },
      });
      return result;
    }

    const result: TaskSplitResult = await launcher.launch(proposal, { startRuns: wantRuns });
    return result;
  });

  /**
   * Просьба разделить задачи, посланная кнопкой, а не инициативой агента. Текст
   * живёт на сервере по той же причине, что и системная строка: он описывает
   * ФОРМАТ ответа, и второй его копии в клиенте быть не должно. Инструкцию
   * прикладываем целиком — кнопкой пользуются и при выключенной инициативе,
   * когда системной строки в прогоне нет вовсе.
   */
  app.get<{ Querystring: { path?: string; model?: string; effort?: string } }>(
    '/api/chat/split/request',
    (request) => {
      // Про классы работы говорим ровно тогда, когда панель их и применит: путь
      // нужен, чтобы прочесть правило проекта, модель и глубина — чтобы назвать
      // агенту настоящий потолок этого разговора, а не значение из настроек.
      const { path, model: chatModel, effort: chatEffort } = request.query ?? {};
      const ceiling = cascadeCeilingFor(
        { entries: ctx.store.getProjectCascadeEntries(), settings: ctx.store.getSettings() },
        String(path ?? ''),
        { model: chatModel, effort: chatEffort },
      );
      const cascade = ceiling ? cascadeSystemPrompt(ceiling) : '';

      return {
        prompt: [
          'Раздели задачи из этого разговора на независимые группы и предложи разделение.',
          SPLIT_SYSTEM_PROMPT,
          cascade,
        ]
          .filter(Boolean)
          .join(' '),
      };
    },
  );

  /**
   * «Работаем здесь» — отказ от разделения. Отказ уходит агенту и репликой, но
   * реплика живёт ровно один ход, а инициатива дописывается к КАЖДОМУ прогону:
   * без этой отметки следующий же прогон предложил бы ровно то же самое, и так
   * до бесконечности. Кнопка «Разделить задачи» после отказа работает по-прежнему.
   */
  app.post<{ Body: { chatId?: string } }>('/api/chat/split/decline', (request) => {
    const chatId = String(request.body?.chatId ?? '').trim();
    if (chatId) deps.runs.muteSplit(chatId);
    return { ok: Boolean(chatId) };
  });

  /**
   * Ответ человека на вопрос разбора (`hold`). Адресуется РОДИТЕЛЕМ, а не чатом
   * группы: чата у стоящей группы ещё нет — копия заводится после ответа.
   * Отвечено — стартует сейчас или, если ждёт предшественников, с ними.
   */
  app.post<{
    Params: { parent: string };
    Body: { index?: number; answer?: string };
  }>('/api/chat/split/:parent/hold', async (request, reply) => {
    if (!deps.conveyor)
      return reply
        .code(404)
        .send({ message: 'Конвейер уровней выключен', messageCode: 'split-conveyor-off' });
    const index = Number(request.body?.index);
    const answer = String(request.body?.answer ?? '').trim();
    if (!Number.isInteger(index) || index < 0) {
      return reply
        .code(400)
        .send({ message: 'Нужен номер группы', messageCode: 'split-group-number-required' });
    }
    if (!answer)
      return reply.code(400).send({ message: 'Ответ пустой', messageCode: 'split-answer-empty' });
    try {
      return await deps.conveyor.answerHold(request.params.parent, index, answer);
    } catch (error) {
      return reply.code(409).send({ message: (error as Error).message, ...codeOf(error) });
    }
  });

  /**
   * «Отпустить» группу, которая ждёт предшественников.
   *
   * Вторая и последняя дверь к стоящей группе, и открывается она ровно там, где
   * первой не хватает: ответ на вопрос разбора двигает только `held`, а цепочка
   * предшественника может не кончиться никогда — прогон остановили, чат
   * удалили, панель перезапустилась. Решение человека, а не панели: она сама
   * никого не отпускает и ничего при этом не сливает.
   */
  app.post<{ Params: { parent: string }; Body: { index?: number } }>(
    '/api/chat/split/:parent/release',
    async (request, reply) => {
      if (!deps.conveyor)
        return reply
          .code(404)
          .send({ message: 'Конвейер уровней выключен', messageCode: 'split-conveyor-off' });
      const index = Number(request.body?.index);
      if (!Number.isInteger(index) || index < 0) {
        return reply
          .code(400)
          .send({ message: 'Нужен номер группы', messageCode: 'split-group-number-required' });
      }
      try {
        return await deps.conveyor.release(request.params.parent, index);
      } catch (error) {
        return reply.code(409).send({ message: (error as Error).message, ...codeOf(error) });
      }
    },
  );

  /**
   * «Продолжить» оборванные группы (WP1c): процесс умер посреди хода —
   * перезапуск панели, выключение машины, смерть CLI. Без номера — все
   * оборванные группы разделения, с номером — одна. Каждая продолжается своей
   * сессией с восстановлением состояния; место в очереди она и так держит.
   */
  app.post<{ Params: { parent: string }; Body: { index?: number } }>(
    '/api/chat/split/:parent/resume',
    async (request, reply) => {
      if (!deps.conveyor)
        return reply
          .code(404)
          .send({ message: 'Конвейер уровней выключен', messageCode: 'split-conveyor-off' });
      const raw = request.body?.index;
      const index = raw === undefined || raw === null ? undefined : Number(raw);
      if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
        return reply
          .code(400)
          .send({ message: 'Нужен номер группы', messageCode: 'split-group-number-required' });
      }
      // Отменённый план не оживает «Продолжить» (D6): отмена — решение человека
      // закрыть план, путь дальше — новое «Разделить».
      if (ctx.store.getSplitPlan(request.params.parent)?.cancelledAt) {
        return reply.code(409).send({
          message: 'План отменён: его группы закрыты — начните новое разделение',
          messageCode: 'split-plan-cancelled',
        });
      }
      return deps.conveyor.resumeInterrupted(request.params.parent, index);
    },
  );

  /**
   * Завести незакрытые группы заново из итога разбора (`SplitConveyor.relaunch`)
   * — в корне репозитория, а не там, где они стартовали. Их чаты уходят целиком:
   * прогон остановлен, звено снято (оба ключа разговора), а из паузы дерева
   * вычеркнуты — иначе «Продолжить всё» подняло бы их снова, а воротца паузы
   * отложили бы и новые старты. Связь снимается, а не стирается: стёртая
   * выбрасывала старые чаты групп в корень списка (находка 20), снятая держит их
   * под родителем, а живой для панели уже не считается (`retireChatLink`).
   */
  app.post<{ Params: { parent: string } }>(
    '/api/chat/split/:parent/relaunch',
    async (request, reply) => {
      const conveyor = deps.conveyor;
      if (!conveyor)
        return reply
          .code(404)
          .send({ message: 'Конвейер уровней выключен', messageCode: 'split-conveyor-off' });
      const parent = request.params.parent;
      const record = ctx.store.getSplitPlan(parent);
      if (!record) {
        return reply.code(409).send({
          message: 'Разделения нет: перезапускать нечего',
          messageCode: 'split-relaunch-nothing',
        });
      }
      // Отменённый план не перезапускается (m1): см. `SplitConveyor.relaunch`.
      // Проверка — до ответа 202, иначе отказ ушёл бы только в журнал.
      if (record.cancelledAt) {
        return reply.code(409).send({
          message: 'План отменён: его группы закрыты — начните новое разделение',
          messageCode: 'split-plan-cancelled',
        });
      }
      // Второй перезапуск поверх идущего завёл бы те же группы дважды: первый
      // уже перевёл их в «стартует», второй вернул бы в очередь и запустил снова.
      if (relaunching.has(parent)) {
        return reply.code(409).send({
          message: 'Перезапуск этого разделения уже идёт',
          messageCode: 'split-relaunch-running',
        });
      }
      relaunching.add(parent);
      // `splitRootOf` не бросает: не репозиторий — каталог как есть.
      const root = await splitRootOf(record.projectPath);
      const dropped = new Set(
        record.groups
          .filter((group) => group.status !== 'done' && group.status !== 'pending')
          .flatMap((group) => (group.chatId ? [group.chatId] : [])),
      );
      const links = ctx.store.getChatLinks();
      for (const [key, link] of Object.entries(links)) {
        if (link.conversation && dropped.has(link.conversation)) dropped.add(key);
      }
      dropFromTreePause(ctx, record.parentChatId, dropped);
      // Ответ — сразу, запуск — фоном (находка 19): копия с установкой зависимостей
      // заводится минутами, и кнопка, ждущая все копии, выглядела зависшей.
      // Ход перезапуска виден в записи конвейера (дерево родителя): группы
      // переходят в «стартует» ещё до ответа — синхронной частью `relaunch`.
      const started = conveyor.relaunch(parent, root, () => {
        for (const key of dropped) {
          // Чат группы у чужого CLI — ключ с приставкой: его прогон гасит
          // `providerChats`, а не реестр Claude (m2) — иначе старая сессия
          // дописывала бы в копию рядом с новой.
          stopChatKey(deps, key);
          ctx.store.retireChatLink(key);
        }
      });
      void started
        .catch((error: unknown) => app.log.warn({ err: error }, 'split relaunch failed'))
        .finally(() => relaunching.delete(parent));
      return reply.code(202).send({ accepted: true });
    },
  );

  /**
   * Убрать копию закрытой группы (Д19) — по кнопке человека в хабе, и только
   * так: сама панель не удаляет ничего. Ветка уходит вместе с копией, только
   * если она пустая; ветку MR не трогаем вовсе (`removeGroupCopy`).
   */
  app.post<{ Params: { parent: string }; Body: { index?: number; chatId?: string } }>(
    '/api/chat/split/:parent/cleanup',
    async (request, reply) => {
      if (!deps.conveyor)
        return reply
          .code(404)
          .send({ message: 'Конвейер уровней выключен', messageCode: 'split-conveyor-off' });
      // Группа прошлого разделения (F5.2) — по чату: её номер от старого плана.
      const chatId =
        typeof request.body?.chatId === 'string' && request.body.chatId
          ? request.body.chatId
          : undefined;
      const index = Number(request.body?.index);
      if (!chatId && (!Number.isInteger(index) || index < 0)) {
        return reply
          .code(400)
          .send({ message: 'Нужен номер группы', messageCode: 'split-group-number-required' });
      }
      try {
        // Группа помнит чат и черновым ключом `new-…` — ищем по всем ключам разговора.
        const group = chatId
          ? { chatIds: [chatId, ...conversationKeys(ctx.store.getRetiredChatLinks(), chatId)] }
          : index;
        return await deps.conveyor.cleanup(request.params.parent, group, async (target) => {
          // Снести каталог из-под живого процесса — потерять его работу молча.
          const norm = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
          const busy = deps.runs
            .active()
            .some(
              (run) =>
                run.projectPath &&
                norm(run.projectPath) === norm(target.path) &&
                deps.runs.isRunning(run.chatId),
            );
          if (busy) throw agentRunning();
          return removeGroupCopy({
            ...target,
            // Звено прошлого разделения снято, но ветку MR помнит и снятая связь.
            keepBranch: Boolean(
              target.chatId &&
              (
                ctx.store.getChatLink(target.chatId) ??
                ctx.store.getRetiredChatLinks()[target.chatId]
              )?.review,
            ),
            claudeJsonPath: ctx.location.paths.mcpConfig,
            mirror: ctx.store.getWorktreeMirror(target.projectPath),
            // Процесс CLI, ждущий следующего хода, держит копию своим cwd (F4c):
            // занятый ходом или фоном — тот же отказ, простаивающие закрываются,
            // и копия убирается, когда они вышли. Зовётся только для настоящей
            // копии: основную с процессом родителя это не заденет.
            release: async (path) => {
              const pooled = deps.runs.livePool.closeIdleIn(path, { tree: true });
              if (pooled.busy > 0) throw agentRunning();
              await withTimeout(pooled.closed, POOLED_EXIT_WAIT_MS);
            },
          });
        });
      } catch (error) {
        // Непредвиденный отказ git — кодом с его текстом в параметре: панель
        // говорит своими словами на языке человека, а не сырым `error: …`.
        const known = codeOf(error);
        const message = (error as Error).message;
        return reply.code(409).send(
          known.messageCode
            ? { message, ...known }
            : {
                message: `Копию убрать не удалось: ${message}`,
                messageCode: 'split-group-cleanup-failed',
                params: { detail: message.slice(0, 500) },
              },
        );
      }
    },
  );

  /**
   * Пересечения веток разделения (Т6) — по кнопке в хабе. Тот же счёт, что
   * панель делает сама по концу цепочки любой группы: маршрут нужен, чтобы
   * человек мог спросить, не дожидаясь ничьего конца.
   *
   * Пишущей операции здесь нет и быть не может: считается это чтением git, а
   * слияние остаётся человеку — панель ветки не трогает.
   */
  /**
   * Завести предложенный группой тикет в трекере (L277). Кнопка хаба зовёт сюда
   * только после подтверждения человека: запись в чужой сервис — его согласие
   * на эту операцию. Описание собирает панель на языке интерфейса; заголовок —
   * из записи группы, не из тела запроса.
   */
  app.post<{ Params: { parent: string }; Body: { key?: unknown; description?: unknown } }>(
    '/api/chat/split/:parent/tickets/file',
    async (request, reply) => {
      if (!deps.conveyor)
        return reply
          .code(404)
          .send({ message: 'Конвейер уровней выключен', messageCode: 'split-conveyor-off' });
      const key = typeof request.body?.key === 'string' ? request.body.key : '';
      const description =
        typeof request.body?.description === 'string'
          ? request.body.description.slice(0, 8000)
          : '';
      try {
        return await deps.conveyor.fileTicket(request.params.parent, key, (ticket, projectKey) =>
          tracker.create(projectKey, ticket.title, description || ticket.why),
        );
      } catch (error) {
        if (error instanceof IntegrationError) return fail(reply, error);
        return reply.code(409).send({ message: (error as Error).message, ...codeOf(error) });
      }
    },
  );

  app.get<{ Params: { parent: string } }>(
    '/api/chat/split/:parent/overlap',
    async (request, reply) => {
      if (!deps.overlap)
        return reply
          .code(404)
          .send({ message: 'Сверка веток выключена', messageCode: 'split-overlap-off' });
      const view = await deps.overlap.check(request.params.parent);
      if (!view)
        return reply
          .code(404)
          .send({ message: 'Разделения с уровнями тут нет', messageCode: 'split-levels-missing' });
      return view;
    },
  );

  /**
   * Решение человека по ревью MR (Т7): чинить, отписать, и то и другое, ничего.
   *
   * Маршрут ПИШУЩИЙ, и это единственное место, откуда панель пишет в чужой MR.
   * Клик и есть согласие: ни настройки, ни автоматики, которая сделала бы это
   * сама, здесь нет и не будет. `all` — то же решение всем ревью-группам дерева,
   * которые ещё ждут: разбирать десять одинаковых карточек руками незачем.
   */
  app.post<{
    Params: { parent: string };
    Body: { chatId?: string; decision?: string; all?: boolean };
  }>('/api/chat/split/:parent/review-decision', async (request, reply) => {
    if (!deps.review)
      return reply
        .code(404)
        .send({ message: 'Ревью по ссылкам выключено', messageCode: 'split-review-off' });
    const chatId = String(request.body?.chatId ?? '').trim();
    const decision = String(request.body?.decision ?? '');
    if (!chatId)
      return reply
        .code(400)
        .send({ message: 'Не указан разговор', messageCode: 'conversation-unspecified' });
    if (decision !== 'fix' && decision !== 'post' && decision !== 'both' && decision !== 'none') {
      return reply
        .code(400)
        .send({ message: 'Неизвестное решение', messageCode: 'split-review-decision-unknown' });
    }
    const outcome = await deps.review.decide({
      chatId,
      decision,
      // Дерево из адреса — проверка, а не украшение: вкладка, помнящая чужое
      // разделение, иначе прошлась бы «применить ко всем» по группам, которых
      // человек сейчас не видит.
      parentChatId: request.params.parent,
      ...(request.body?.all === true ? { applyToAll: true } : {}),
    });
    // Ни один чат не подошёл — решение уже принято или карточки не было. Это не
    // ошибка запроса: две вкладки нажимают одну кнопку чаще, чем кажется.
    if (outcome.applied.length === 0) {
      return reply.code(409).send({
        message: 'Решение по этому ревью уже принято',
        messageCode: 'split-review-decided',
      });
    }
    return outcome;
  });

  /**
   * «Закоммитить и отправить в MR» (Т7) — отдельный клик после правок по ревью.
   *
   * Отдельным маршрутом, а не решением: это запись в ЧУЖУЮ ветку, и человек
   * соглашается на неё вторым, осознанным нажатием, уже увидев, что правки
   * сделаны.
   */
  app.post<{ Params: { parent: string }; Body: { chatId?: string } }>(
    '/api/chat/split/:parent/review-push',
    (request, reply) => {
      if (!deps.review)
        return reply
          .code(404)
          .send({ message: 'Ревью по ссылкам выключено', messageCode: 'split-review-off' });
      const chatId = String(request.body?.chatId ?? '').trim();
      if (!chatId)
        return reply
          .code(400)
          .send({ message: 'Не указан разговор', messageCode: 'conversation-unspecified' });
      const outcome = deps.review.push({ chatId, parentChatId: request.params.parent });
      if (outcome.applied.length === 0) {
        return reply.code(409).send({
          message: 'Отправлять нечего: правок по ревью здесь не было',
          messageCode: 'split-review-nothing-to-send',
        });
      }
      const refused = outcome.applied[0]?.refused;
      if (refused) return reply.code(409).send(REFUSALS[refused]);
      return outcome;
    },
  );

  /**
   * «Повторить итог ревью» (Д4): ответ ревью кончился без блока, и группа висит
   * без замечаний. Сообщение уходит в ту же сессию — MR она уже прочитала.
   */
  app.post<{ Params: { parent: string }; Body: { chatId?: string } }>(
    '/api/chat/split/:parent/review-retry',
    (request, reply) => {
      if (!deps.review)
        return reply
          .code(404)
          .send({ message: 'Ревью по ссылкам выключено', messageCode: 'split-review-off' });
      const chatId = String(request.body?.chatId ?? '').trim();
      if (!chatId)
        return reply
          .code(400)
          .send({ message: 'Не указан разговор', messageCode: 'conversation-unspecified' });
      const outcome = deps.review.retryReview({ chatId, parentChatId: request.params.parent });
      if (outcome.applied.length === 0) {
        return reply.code(409).send({
          message: 'Итог ревью уже получен — повторять нечего',
          messageCode: 'split-review-not-missing',
        });
      }
      const refused = outcome.applied[0]?.refused;
      if (refused) return reply.code(409).send(REFUSALS[refused]);
      return outcome;
    },
  );

  // Пауза, продолжение с паузы, «запустить сейчас» (журнал 81, 89).
  registerSplitControlRoutes(app, ctx, deps);
}

/** Отказ запуска — текстом и кодом: клиент переводит код, лог читает текст. */
const agentRunning = (): Error =>
  coded(
    new Error('В этой копии работает агент — остановите его и повторите'),
    'worktree-agent-running',
  );

/** Сколько ждать выхода закрытых простаивающих CLI перед уборкой копии. */
const POOLED_EXIT_WAIT_MS = 15_000;

/** Дождаться промиса, но не дольше `ms`; пустой — сразу. */
async function withTimeout(promise: Promise<void> | undefined, ms: number): Promise<void> {
  if (!promise) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([promise, new Promise<void>((done) => (timer = setTimeout(done, ms)))]);
  clearTimeout(timer);
}

/** Снять ключи из паузы дерева родителя; пустая пауза снимается целиком. */
function dropFromTreePause(ctx: ServerContext, parent: string, dropped: ReadonlySet<string>): void {
  const pause = ctx.store.getTreePause(parent);
  if (!pause) return;
  for (const key of Object.keys(pause.chats)) if (dropped.has(key)) delete pause.chats[key];
  pause.pendingStarts = pause.pendingStarts.filter((item) => !dropped.has(item.chatId));
  if (Object.keys(pause.chats).length === 0 && pause.pendingStarts.length === 0) {
    ctx.store.clearTreePause(pause.root);
  } else {
    ctx.store.setTreePause(pause);
  }
}

/** Все живые звенья прошлых разделений этого родителя — в снятые. */
function retirePreviousSplit(ctx: ServerContext, parent: string): void {
  const previous = new Set(
    Object.entries(ctx.store.getChatLinks())
      .filter(([, link]) => link.parentChatId === parent)
      .map(([key]) => key),
  );
  if (previous.size === 0) return;
  for (const key of previous) ctx.store.retireChatLink(key);
  dropFromTreePause(ctx, parent, previous);
}

const REFUSALS: Record<SplitReviewRefusal, { message: string; messageCode: string }> = {
  'branch-unknown': {
    message: 'Ветка MR неизвестна — push ушёл бы в новую ветку, а не в MR',
    messageCode: 'split-review-branch-unknown',
  },
  'no-session': {
    message: 'Разговор ещё не начался — продолжать нечего',
    messageCode: 'split-review-no-session',
  },
  busy: {
    message: 'Чат ещё работает — дождитесь конца хода',
    messageCode: 'split-review-busy',
  },
  'start-failed': { message: 'Запуск не удался', messageCode: 'split-review-start-failed' },
};
