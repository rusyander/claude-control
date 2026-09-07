import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  parseSplitProposal,
  SPLIT_SYSTEM_PROMPT,
  type TaskSplitResult,
} from '@agentdeck/contracts/task-split';
import type { ServerContext } from '../../context.ts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry.ts';
import type { ChatSession } from '../../domains/chat/ChatSession.ts';
import { apiTokenPath } from '../../lib/api-token.ts';
import { initiativePrompt } from '../../domains/chat/initiative.ts';
import { activateGroupsQuietly } from '../../domains/group-activation.ts';
import {
  cascadeCeilingFor,
  expandAssignedModel,
  isCascadeEnabled,
} from '../../domains/model-cascade.ts';
import { planForeignAssignment } from '../../domains/provider-cascade.ts';
import {
  cascadeSystemPrompt,
  clampAssignment,
  loweredWorkPrompt,
  manualAssignment,
  parseAssignments,
  planAssignment,
  type CascadePlan,
} from '@agentdeck/contracts/model-cascade';
import { splitTasks } from '../../domains/chat/ChatSplit.ts';
import { createChat, type ProviderChatService } from '../../domains/provider-chat.ts';
import { checkProjectDir } from '../../domains/projects.ts';
import { getActiveProvider } from '../../providers/registry.ts';
import { activeCliCommand } from '../../providers/cli.ts';

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
 */
export function registerChatSplitRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: { runs: ChatRunRegistry; providerChats: ProviderChatService; session: ChatSession },
): void {
  const selfBaseUrl = `http://127.0.0.1:${process.env.PORT ?? 5178}`;

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
    // запросы прав. Взвести его отсюда значило бы завести ВТОРОЙ объект сессии,
    // о котором маршрут прав ничего не знает, — тумблер бы не действовал, но
    // выглядел бы включённым. Дети получают его иначе — наследованием от
    // родителя, `session.inherit` ниже.
    const { projectPath, startRuns, allowEdits, model, effort, parentChatId } = request.body ?? {};

    const problem = checkProjectDir(String(projectPath ?? ''));
    if (problem) return reply.code(400).send({ message: problem });
    const dir = resolve(projectPath as string);

    // Разбор тот же самый, которым панель узнаёт блок в ответе: два понимания
    // формата — два разных набора заведённых веток при одном и том же тексте.
    const proposal = parseSplitProposal(request.body?.proposal);
    if (!proposal) {
      return reply
        .code(400)
        .send({ message: 'Разделение не разобрано: нужны минимум две группы с задачами' });
    }

    const provider = getActiveProvider(ctx.store);
    // Чужой CLI ведёт разговор своим хранилищем, и подбор модели у него устроен
    // иначе — от лестницы провайдера, а не от потолка разговора (см.
    // `domains/provider-cascade.ts`). Развилка одна на весь маршрут.
    const isForeign = provider.id !== 'claude';
    const wantRuns = startRuns !== false;
    // Замены человека: чем бы ни оказалось поле, отсюда выходит карта понятных
    // значений — незнакомое отброшено, потолок всё равно держится ниже.
    const manual = parseAssignments(request.body?.assignments);

    // Правило проекта одно на обе ветки: выключив подбор в репозитории, человек
    // выключил его и чужому CLI — тумблер стоит на проекте, а не на провайдере.
    const cascadeEntries = ctx.store.getProjectCascadeEntries();
    // Потолок разговора и правило проекта: `undefined` — подбор здесь выключен,
    // и дальше всё идёт ровно как до партии подбора (дети = выбранная модель).
    //
    // У чужого провайдера потолка НЕТ вовсе, и подставлять сюда настройку панели
    // нельзя: в ней имя модели Claude, а прогон пойдёт кодексом. До правки от
    // 07.09.2026 так и было — карточка и связь показывали `claude-sonnet-5` там,
    // где CLI работал своей настройкой.
    const ceiling = isForeign
      ? undefined
      : cascadeCeilingFor({ entries: cascadeEntries, settings: ctx.store.getSettings() }, dir, {
          model,
          effort,
        });
    // Каталог моделей: им алиас разворачивается в свежую модель семейства.
    // Читается один раз на запрос — он один и тот же для всех групп.
    const catalog = ctx.models.current(provider.modelVendors ?? []).models;
    // Потолок в том виде, в каком с ним можно ЗАПУСТИТЬ прогон: `max` срезан до
    // `xhigh`, незнакомая глубина — до пустой строки. Клэмп пустого пожелания
    // делает ровно это, и второй его копии здесь заводить незачем.
    //
    // Алиас разворачивается и здесь: этот потолок уезжает в связь и по нему
    // пойдёт РЕВЬЮ работы — проверка обязана идти на том же поколении, что
    // выбрал человек, а не на прошлом (см. `expandAssignedModel`).
    const runnableCeiling = ceiling
      ? (() => {
          const clamped = clampAssignment({}, ceiling);
          return { ...clamped, model: expandAssignedModel(catalog, clamped.model) };
        })()
      : undefined;

    const result: TaskSplitResult = await splitTasks({
      projectPath: dir,
      proposal,
      startRuns: wantRuns,
      /**
       * Дерево в списке чатов. Пишем ДО запуска прогона и только по удавшимся
       * группам: ветвь, ведущая в чат, которого не завелось, — это не дерево, а
       * ложь о состоянии, а связь, записанная после запуска, не успевает к
       * переносу ключа и пропадает целиком (см. `SplitLink`).
       *
       * Ключ здесь временный (`new-…`), и это правильно: под ним чат уже
       * открывается, а на настоящий `sessionId` связь переедет сама, как только
       * прогон его назовёт (слушатель в `bootstrap/runtime.ts`).
       */
      /**
       * Чем делать группу. Считается здесь, потому что здесь известны обе
       * половины потолка — оверрайд шапки этого разговора и настройка панели, —
       * а также правило проекта. Разделение только разносит ответ.
       */
      assign: isForeign
        ? // Чужой CLI: ступень лестницы провайдера по классу работы, и только
          // вниз. Классу-потолку (`design`, `investigation`, `review`) и любому
          // CLI без лестницы отвечается `undefined` — прогон идёт настройкой
          // пользователя, а карточка ничего про модель не обещает. Ручные замены
          // с карточки здесь не участвуют: её список — алиасы Claude, у чужого
          // вендора не значащие ничего.
          (group, prompt) =>
            isCascadeEnabled(cascadeEntries, dir)
              ? planForeignAssignment(provider, catalog, {
                  ...(group.kind ? { kind: group.kind } : {}),
                  tasks: group.tasks.length,
                  length: prompt.length,
                })
              : undefined
        : ceiling
          ? (group, prompt, index) => {
              const auto = planAssignment(
                {
                  ...(group.kind ? { kind: group.kind } : {}),
                  ...(group.model ? { model: group.model } : {}),
                  ...(group.effort ? { effort: group.effort } : {}),
                  tasks: group.tasks.length,
                  length: prompt.length,
                },
                ceiling,
              );
              // Замена человека сильнее подбора и действует ВНИЗ тоже: он видел
              // задачи группы. Класс при этом остаётся распознанным — по нему
              // группа подписана на карточке и по нему же пишется связь.
              const wish = manual.get(index);
              const plan = wish ? manualAssignment(wish, ceiling, auto.kind) : auto;
              // Алиас — в свежую модель семейства, последним шагом: сравнение силы
              // идёт по алиасам, а прогону нужно имя, за которым не прячется
              // прошлое поколение.
              return { ...plan, model: expandAssignedModel(catalog, plan.model) };
            }
          : undefined,
      // Связь пишется только у Claude, и это не пробел. Ключ здесь временный
      // (`new-…`) и переезжает на настоящий `sessionId` прогона; у чужого CLI
      // разговор заводит его собственное хранилище со своим идентификатором, и
      // связь под временным ключом осталась бы записью о чате, которого нет.
      // Дерево чатов и сводка звеньев у чужих провайдеров поэтому не работают.
      // Конвейер ревью работает — он живёт не на связях, а на стадии в шапке
      // самого разговора (`domains/provider-chat/cascade.ts`).
      link:
        parentChatId && !isForeign
          ? ({ chatId, title, branch, assignment }) =>
              ctx.store.setChatLink(chatId, {
                parentChatId,
                title,
                branch,
                createdAt: new Date().toISOString(),
                // Назначение живёт в связи, а не только в прогоне: второе
                // сообщение ребёнку приходит уже без него (телефон и API модель
                // не шлют вовсе), и без этой записи оно уехало бы на дефолте.
                ...(assignment
                  ? {
                      model: assignment.model,
                      effort: assignment.effort,
                      lowered: assignment.lowered,
                      stage: 'work',
                      ...(assignment.kind ? { kind: assignment.kind } : {}),
                      // Потолок ЭТОГО разговора — на нём пойдёт ревью работы.
                      // Пересчитать его потом нечем: половина потолка жила в шапке
                      // родительского чата, которого к тому времени уже нет.
                      ...(runnableCeiling
                        ? {
                            ceilingModel: runnableCeiling.model,
                            ceilingEffort: runnableCeiling.effort,
                          }
                        : {}),
                    }
                  : {}),
              })
          : undefined,
      start: ({ chatId, title, prompt, cwd, branch, assignment }) => {
        // Набор, привязанный к проекту, включается и здесь: агент, которого
        // завело разделение, работает в том же проекте и должен получить те же
        // правила и скиллы. Копия репозитория считается тем же проектом —
        // привязка знает про `<repo>-worktrees/<ветка>`.
        activateGroupsQuietly(
          { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir },
          cwd,
          (error) => app.log.warn({ err: error }, 'group activation failed'),
        );

        return isForeign
          ? startForeign(title, prompt, cwd, branch, assignment)
          : startClaude(chatId, prompt, cwd, assignment);
      },
    });

    // Разделили — значит этот разговор своё решение принял. Предлагать ему то
    // же самое в каждом следующем прогоне не помощь, а навязчивость.
    if (parentChatId) deps.runs.muteSplit(parentChatId);

    return result;

    /** Прогон Claude — тот же путь, что и у обычной отправки в чат проекта. */
    function startClaude(
      chatId: string,
      prompt: string,
      cwd: string,
      assignment?: CascadePlan,
    ): boolean {
      const settings = ctx.store.getSettings();
      // Продолжение в чистой сессии порождённому чату уезжает, а РАЗДЕЛЕНИЕ —
      // нет, и это разные вещи по существу. Чат, только что выделенный под одну
      // группу, получил задание уже разделённым: предлагать дробить его дальше
      // значит спрашивать про то же самое по второму разу, только теперь в
      // шести местах сразу. Живые прогоны 2 сентября так и вышли — каждый агент
      // просил делить на всякое расхождение. Понадобится — человек нажмёт
      // «Разделить задачи» в самом чате, кнопка работает и при молчащей
      // инициативе.
      deps.runs.muteSplit(chatId);
      // Автоподтверждение наследуется от родителя. Иначе веером заведённые дети
      // встают на первом же инструменте и ждут человека, который по построению
      // смотрит в другую вкладку: делят как раз для того, чтобы не сидеть над
      // каждым. Тумблер родителя известен по любому его ключу — временному или
      // настоящему.
      if (parentChatId) deps.session.inherit([parentChatId], chatId);
      // Ребёнку, отправленному на модель ниже потолка, дописывается планка
      // сдачи и право остановиться: понижение оплачивается проверкой, а не
      // надеждой. Ребёнок на потолке получает обычную склейку.
      const initiative = [
        initiativePrompt(settings, { splitMuted: true }),
        assignment?.lowered ? loweredWorkPrompt(assignment.kind) : '',
      ]
        .filter(Boolean)
        .join(' ');
      return deps.runs.start(
        chatId,
        {
          prompt,
          cwd,
          command: activeCliCommand(ctx.store),
          // Назначение сильнее выбора шапки: оно ИЗ него и выведено (потолок),
          // а пустая строка в нём значит «как решит CLI», а не «возьми настройку».
          model: assignment?.model ?? (model || settings.chatModel),
          effort: assignment?.effort ?? (effort || settings.chatEffort),
          permissionMode: allowEdits ? 'acceptEdits' : 'default',
          permissionPrompt: { runId: chatId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() },
          ...(initiative ? { appendSystemPrompt: initiative } : {}),
        },
        {
          projectPath: cwd,
          // Понижённый ребёнок попадает в журнал сдачи вместе с КЛАССОМ, из-за
          // которого его понизили. Без класса журнал отвечает только «сколько
          // раз понизили»; с ним — «что именно и во что обошлось», а это тот
          // самый вопрос, ради которого подбор и затевался.
          ...(assignment?.lowered
            ? {
                lowered: {
                  model: assignment.model,
                  effort: assignment.effort,
                  ...(assignment.kind ? { kind: assignment.kind } : {}),
                },
              }
            : {}),
        },
      );
    }

    /**
     * Разговор чужого CLI. Идентификатор здесь СВОЙ (его выдаёт хранилище
     * провайдера), поэтому ключ из домена не используется — человек находит
     * такой чат в списке разговоров провайдера по НАЗВАНИЮ группы.
     *
     * Назначение модели (Т12) уезжает в шапку разговора, а не только в первый
     * прогон: следующее сообщение в тот же чат приходит без него, и без записи
     * оно ушло бы на настройке CLI — то есть работа продолжилась бы не тем, чем
     * началась. Туда же уезжает и стадия конвейера: связей панели у этих
     * разговоров нет, и другого места, переживающего перезапуск сервера, у них
     * тоже нет (`domains/provider-chat/cascade.ts`).
     */
    function startForeign(
      title: string,
      prompt: string,
      cwd: string,
      branch: string,
      assignment?: CascadePlan,
    ): boolean {
      const appData = ctx.location.paths.appData;
      const created = createChat(appData, provider.id, {
        title,
        workdir: cwd,
        ...(assignment ? { model: assignment.model, effort: assignment.effort } : {}),
        // Стадия пишется ТОЛЬКО понижённой группе: работа, идущая настройкой
        // самого CLI, ревью не получает — усиливать её нечем, прогон проверки
        // пошёл бы ровно той же моделью.
        ...(assignment?.lowered
          ? {
              cascade: {
                stage: 'work' as const,
                group: title,
                branch,
                lowered: true,
                workModel: assignment.model,
                workEffort: assignment.effort,
                ...(assignment.kind ? { kind: assignment.kind } : {}),
              },
            }
          : {}),
      });
      if (!created) return false;
      // У чужого CLI инициатива — первая реплика переписки, а не флаг запуска.
      // Без неё порождённый чат вёл бы себя иначе, чем тот же чат после первого
      // же вопроса из панели, — а тумблер в настройках один. Разделение из неё
      // выключено по той же причине, что и у Claude: этот чат уже выделен.
      const initiative = [
        initiativePrompt(ctx.store.getSettings(), { splitMuted: true, foreign: true }),
        // Планка сдачи и обещание ревью. Ревьюером здесь работает настроенная
        // модель самого CLI — прогон без подобранной ступени: потолка у чужого
        // провайдера нет вовсе, панель умеет только понижать (см.
        // `domains/provider-cascade.ts`), и «модель сильнее» ему не обещается.
        assignment?.lowered ? loweredWorkPrompt(assignment.kind, { reviewer: 'cli' }) : '',
      ]
        .filter(Boolean)
        .join(' ');
      const outcome = deps.providerChats.send(
        appData,
        provider.id,
        created.id,
        { text: prompt },
        {
          provider,
          models: catalog,
          ...(initiative ? { systemPrefix: initiative } : {}),
        },
      );
      return outcome.ok;
    }
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
}
