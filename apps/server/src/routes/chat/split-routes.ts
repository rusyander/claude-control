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
import { checkProjectDir } from '../../domains/projects.ts';
import { createSplitLauncher, type SplitLaunchDeps } from './split-launch.ts';

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
  },
): void {
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
      return reply
        .code(400)
        .send({ message: 'Разделение не разобрано: нужны минимум две группы с задачами' });
    }

    const wantRuns = startRuns !== false;
    const launcher = createSplitLauncher(
      ctx,
      { ...deps, log: app.log },
      {
        projectPath: projectPath as string,
        ...(parentChatId ? { parentChatId } : {}),
        ...(allowEdits !== undefined ? { allowEdits } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(request.body?.assignments !== undefined
          ? { assignments: request.body.assignments }
          : {}),
      },
    );

    // Разделили — значит этот разговор своё решение принял. Предлагать ему то
    // же самое в каждом следующем прогоне не помощь, а навязчивость.
    if (parentChatId) deps.runs.muteSplit(parentChatId);

    // Уровни (Т1): подбор включён, прогоны нужны, родитель известен — разбор
    // идёт первым, группы заводит конвейер. «Только завести чаты» уровней не
    // получает: человек просил заготовки, а не работу.
    if (deps.conveyor && launcher.planned && wantRuns && parentChatId) {
      const manual = parseAssignments(request.body?.assignments);
      const { result } = await deps.conveyor.begin({
        parentChatId,
        projectPath: projectPath as string,
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
    if (!deps.conveyor) return reply.code(404).send({ message: 'Конвейер уровней выключен' });
    const index = Number(request.body?.index);
    const answer = String(request.body?.answer ?? '').trim();
    if (!Number.isInteger(index) || index < 0) {
      return reply.code(400).send({ message: 'Нужен номер группы' });
    }
    if (!answer) return reply.code(400).send({ message: 'Ответ пустой' });
    try {
      return await deps.conveyor.answerHold(request.params.parent, index, answer);
    } catch (error) {
      return reply.code(409).send({ message: (error as Error).message });
    }
  });

  /**
   * Пересечения веток разделения (Т6) — по кнопке в хабе. Тот же счёт, что
   * панель делает сама по концу цепочки любой группы: маршрут нужен, чтобы
   * человек мог спросить, не дожидаясь ничьего конца.
   *
   * Пишущей операции здесь нет и быть не может: считается это чтением git, а
   * слияние остаётся человеку — панель ветки не трогает.
   */
  app.get<{ Params: { parent: string } }>(
    '/api/chat/split/:parent/overlap',
    async (request, reply) => {
      if (!deps.overlap) return reply.code(404).send({ message: 'Сверка веток выключена' });
      const view = await deps.overlap.check(request.params.parent);
      if (!view) return reply.code(404).send({ message: 'Разделения с уровнями тут нет' });
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
    if (!deps.review) return reply.code(404).send({ message: 'Ревью по ссылкам выключено' });
    const chatId = String(request.body?.chatId ?? '').trim();
    const decision = String(request.body?.decision ?? '');
    if (!chatId) return reply.code(400).send({ message: 'Не указан разговор' });
    if (decision !== 'fix' && decision !== 'post' && decision !== 'both' && decision !== 'none') {
      return reply.code(400).send({ message: 'Неизвестное решение' });
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
      return reply.code(409).send({ message: 'Решение по этому ревью уже принято' });
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
      if (!deps.review) return reply.code(404).send({ message: 'Ревью по ссылкам выключено' });
      const chatId = String(request.body?.chatId ?? '').trim();
      if (!chatId) return reply.code(400).send({ message: 'Не указан разговор' });
      const outcome = deps.review.push({ chatId, parentChatId: request.params.parent });
      if (outcome.applied.length === 0) {
        return reply
          .code(409)
          .send({ message: 'Отправлять нечего: правок по ревью здесь не было' });
      }
      return outcome;
    },
  );
}
