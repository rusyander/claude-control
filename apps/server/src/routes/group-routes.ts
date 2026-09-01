import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  Automation,
  Group,
  GroupDraft,
  GroupScenario,
  HookEvent,
} from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { readHooks, writeHooks } from '../domains/hooks.ts';
import type { EntityToggleDeps } from '../domains/entity-toggle.ts';
import {
  applyGroupEnvState,
  reconcileMembers,
  releaseGroupMembers,
  sameEnv,
  setGroupEnabled,
} from '../domains/group-toggle.ts';
import {
  compileScenarioHooks,
  compileScenarioSkill,
  isValidTrigger,
} from '../domains/group-scenario.ts';
import { activateGroupsForCwd } from '../domains/group-activation.ts';
import { wouldCreateCycle } from '../domains/group-graph.ts';

/**
 * Что доменные функции переключения берут от контекста. Собираем на каждом
 * обращении, а не один раз при регистрации: каталог конфигурации меняется на
 * лету (`ctx.relocate`), вместе с ним — пути и хранилище состояния.
 */
function toggleDeps(ctx: ServerContext): EntityToggleDeps {
  return { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir };
}

/**
 * Группы и сценарии — надстройка приложения. Claude Code про них не знает,
 * поэтому и то и другое перед сохранением компилируется в обычные сущности:
 * автоматизация — в хук settings.json, сценарий группы — в скилл и, если задан
 * триггер, в хук `UserPromptSubmit`.
 */
export function registerGroupRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/groups', () => ctx.store.getGroups());

  /**
   * Умолчания проставляются здесь, а не берутся из схемы контрактов: типы
   * TypeScript при выполнении стираются, а сам пакет contracts реэкспортирует
   * модули без расширений — Node его как значение не подключит. Без этого
   * запись без необязательного поля доходила до интерфейса неполной, и
   * страница групп падала на `Object.keys(undefined)`.
   */
  const withDefaults = (body: Partial<Group>): Omit<Group, 'id' | 'order'> => ({
    name: body.name ?? '',
    description: body.description ?? '',
    color: body.color ?? 'accent',
    icon: body.icon ?? 'folder',
    members: body.members ?? [],
    env: body.env ?? {},
    projectPaths: body.projectPaths ?? [],
    scenario: normalizeScenario(body.scenario),
    isEnabled: body.isEnabled ?? true,
  });

  /**
   * Сохранение группы вместе со сценарием: шаги пишутся в скилл, скилл
   * становится участником группы. Общее для создания и правки — иначе новая
   * группа со сценарием получила бы скилл только со второго сохранения.
   */
  const persist = (group: Group, previousMembers: Group['members']): Group => {
    const deps = toggleDeps(ctx);
    const skillId = compileScenarioSkill(deps, group);

    // Скилл сценария обязан быть участником: иначе он не погаснет вместе с
    // группой и остался бы включённым во всех проектах разом.
    const ready: Group =
      skillId && group.scenario
        ? {
            ...group,
            scenario: { ...group.scenario, compiledSkillId: skillId },
            members: group.members.some(
              (member) => member.kind === 'skill' && member.id === skillId,
            )
              ? group.members
              : [...group.members, { kind: 'skill' as const, id: skillId }],
          }
        : group;

    const saved = ctx.store.saveGroup(ready);
    reconcileMembers(deps, saved, previousMembers);
    compileScenarioHooks(deps);
    return saved;
  };

  app.post<{ Body: GroupDraft }>('/api/groups', (request, reply) => {
    // Тело нормализуем один раз: Fastify отдаёт `undefined` на запрос без тела и
    // `null` на литерал `null`, а `withDefaults` ниже читает поля напрямую —
    // без этого пустой запрос падал бы пятисоткой вместо пустой группы.
    const body = request.body ?? ({} as GroupDraft);
    // Набор без имени человеку не опознать: в списке он безымянная строка,
    // выключить которую можно только угадав. Оборванный запрос должен получить
    // отказ, а не завести призрака в настоящем конфиге.
    if (!body.name?.trim()) return reply.code(400).send({ error: 'Не указано имя набора' });

    const id = randomUUID();
    // Вложенная группа может замкнуть цикл (A→B→A) — тогда обход состава не
    // завершился бы. Отвергаем ещё до сохранения, а не чиним на обходе.
    if (wouldCreateCycle(ctx.store.getGroups(), id, body.members ?? [])) {
      return reply.code(400).send({ error: 'Вложение групп образует цикл' });
    }
    const invalid = triggerError(body.scenario);
    if (invalid) return reply.code(400).send({ error: invalid });

    const group: Group = {
      ...withDefaults(body),
      id,
      order: ctx.store.getGroups().length,
    };
    return persist(group, []);
  });

  app.put<{ Params: { id: string }; Body: Group }>('/api/groups/:id', (request, reply) => {
    // Причина та же, что и у создания: запрос без тела — это 400 по существу
    // («править нечем»), а не поломка сервера.
    const body = request.body ?? ({} as Group);
    // Имя обязательно и здесь: PUT по неизвестному id ЗАВОДИТ набор, поэтому
    // без проверки оборванный запрос создавал безымянного — ровно как POST.
    if (!body.name?.trim()) return reply.code(400).send({ error: 'Не указано имя набора' });

    // Группа не может входить сама в себя ни напрямую, ни через цепочку вложенных
    // — иначе включение/выключение зациклилось бы по ветке.
    if (wouldCreateCycle(ctx.store.getGroups(), request.params.id, body.members ?? [])) {
      return reply.code(400).send({ error: 'Вложение групп образует цикл' });
    }
    const invalid = triggerError(body.scenario);
    if (invalid) return reply.code(400).send({ error: invalid });

    // Клиент шлёт GroupDraft без поля order, поэтому при правке порядок нельзя
    // сбрасывать в 0 (иначе редактирование любой группы перекидывало бы её в
    // начало списка и сталкивало по order с уже существующей нулевой). Берём
    // прежний order группы, если тело его не прислало.
    const existing = ctx.store.getGroups().find((item) => item.id === request.params.id);
    // Скомпилированный скилл держится за группой, а не за телом запроса:
    // клиент про его id не знает, и без этого каждая правка заводила бы новый.
    const scenario = normalizeScenario(body.scenario, existing?.scenario);

    const saved = persist(
      {
        ...withDefaults(body),
        scenario,
        id: request.params.id,
        order: body.order ?? existing?.order ?? 0,
      },
      existing?.members ?? [],
    );
    // Правка переменных у включённой группы применяется сразу: снимаем прежние
    // свои ключи и накладываем заново. Но переприменяем только когда есть за чем:
    // набор env реально изменился ЛИБО группу этим же PUT включили (её ключи
    // были сняты при выключении и их надо вернуть). Правка без изменения env
    // (переименование, смена цвета) не должна зря переписывать settings.json.
    const envChanged = !sameEnv(existing?.env, saved.env);
    if (saved.isEnabled && (envChanged || !existing?.isEnabled)) {
      applyGroupEnvState(toggleDeps(ctx), saved, false);
      applyGroupEnvState(toggleDeps(ctx), saved, true);
    }
    return saved;
  });

  app.post<{ Params: { id: string }; Body: { isEnabled: boolean } }>(
    '/api/groups/:id/enabled',
    (request, reply) => {
      const group = ctx.store.getGroups().find((item) => item.id === request.params.id);
      if (!group) return reply.code(404).send({ error: 'Группа не найдена' });

      // Состояние обязано прийти явно: домыслить его тут значило бы переключить
      // группу не туда, куда просили, — а это правка настоящего ~/.claude.
      const isEnabled = request.body?.isEnabled;
      if (typeof isEnabled !== 'boolean') {
        return reply.code(400).send({ error: 'Не указано состояние группы' });
      }

      const result = setGroupEnabled(toggleDeps(ctx), group, isEnabled);

      return {
        ok: true,
        backupPath: result.backupPath,
        needsRestart: true,
        // Считаем только тех, кого действительно переключили: пропущенные
        // локальные хуки уходят отдельным числом, а не растворяются в общем.
        affected: result.affected,
        skippedLocalHooks: result.skippedLocalHooks,
      };
    },
  );

  /**
   * Включить группы, привязанные к каталогу. Тем же путём идут браузер, телефон
   * и разделение задач по чатам, поэтому решение принимает сервер, а не клиент.
   */
  app.post<{ Body: { path?: string } }>('/api/groups/activate', (request) =>
    // Тело читаем через `?.`: запрос без него — не ошибка сервера, а «включать
    // нечего», и 500 здесь означал бы, что панель сломалась на пустом месте.
    activateGroupsForCwd(toggleDeps(ctx), request.body?.path ?? ''),
  );

  app.delete<{ Params: { id: string } }>('/api/groups/:id', (request) => {
    // Группа уходит — её отметки должны уйти вместе с ней, иначе участники
    // остались бы погашенными навсегда, без видимой причины.
    const group = ctx.store.getGroups().find((item) => item.id === request.params.id);
    const deps = toggleDeps(ctx);

    if (group && !group.isEnabled) releaseGroupMembers(deps, group);

    // Снимаем переменные окружения, которые держала эта группа (кроме общих с
    // другими). Работает и для включённой группы: её ключи не должны пережить её.
    if (group) applyGroupEnvState(deps, group, false);

    ctx.store.deleteGroup(request.params.id);
    // Скилл сценария остаётся на диске: это обычный скилл, и удалять чужую
    // работу вместе с группой панель не вправе. А вот триггер уходит — он
    // ссылался на группу, которой больше нет.
    compileScenarioHooks(deps);
    return { ok: true };
  });

  app.get('/api/automations', () => ctx.store.getAutomations());

  /**
   * Сценарий компилируется в хук `settings.json`, поэтому пустой записи здесь
   * быть не должно: без события и команды в конфиг ушёл бы хук, который ничего
   * не ловит и ничего не делает, а в списке появилась бы безымянная строка.
   */
  const automationError = (body: Partial<Automation>): string | undefined => {
    if (!body.name?.trim()) return 'Не указано имя сценария';
    if (!body.trigger?.event) return 'Не указано событие сценария';
    if (!body.action?.command?.trim()) return 'Не указана команда сценария';
    return undefined;
  };

  app.post<{ Body: Partial<Omit<Automation, 'id'>> }>('/api/automations', (request, reply) => {
    const invalid = automationError(request.body);
    if (invalid) return reply.code(400).send({ error: invalid });

    const automation: Automation = {
      ...(request.body as Omit<Automation, 'id'>),
      id: randomUUID(),
    };
    ctx.store.saveAutomation(automation);
    compileAutomations(ctx);
    return automation;
  });

  app.put<{ Params: { id: string }; Body: Partial<Automation> }>(
    '/api/automations/:id',
    (request, reply) => {
      const invalid = automationError(request.body);
      if (invalid) return reply.code(400).send({ error: invalid });

      const automation = ctx.store.saveAutomation({
        ...(request.body as Automation),
        id: request.params.id,
      });
      compileAutomations(ctx);
      return automation;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/automations/:id', (request) => {
    ctx.store.deleteAutomation(request.params.id);
    compileAutomations(ctx);
    return { ok: true };
  });
}

/**
 * Сценарий из тела запроса с проставленными умолчаниями. Причина та же, что у
 * `withDefaults`: схема контрактов при выполнении недоступна, а неполный шаг
 * уронил бы сборку скилла на `undefined.trim()`.
 */
function normalizeScenario(
  scenario?: Partial<GroupScenario>,
  previous?: GroupScenario,
): GroupScenario | undefined {
  if (!scenario) return undefined;

  return {
    when: scenario.when ?? '',
    trigger: scenario.trigger ?? '',
    steps: (scenario.steps ?? []).map((step) => ({
      title: step.title ?? '',
      body: step.body ?? '',
      gate: step.gate ?? '',
    })),
    compiledSkillId: scenario.compiledSkillId ?? previous?.compiledSkillId,
  };
}

/** Текст отказа для негодного выражения триггера — или пусто, если всё в порядке. */
function triggerError(scenario?: Partial<GroupScenario>): string | undefined {
  if (!scenario?.trigger || isValidTrigger(scenario.trigger)) return undefined;
  return 'Выражение триггера не является регулярным выражением';
}

/**
 * Переносит включённые сценарии-автоматизации в settings.json. Ранее
 * скомпилированные записи помечены маркером в команде, поэтому их можно
 * отличить от хуков, написанных руками, и пересобрать, не задев чужое.
 */
const MARKER = '# claude-control:automation';

function compileAutomations(ctx: ServerContext): void {
  const { settings } = ctx.location.paths;
  const manual = readHooks(settings, ctx.store).filter((hook) => !hook.command.includes(MARKER));

  const compiled = ctx.store
    .getAutomations()
    .filter((automation) => automation.isEnabled)
    .map((automation) => ({
      id: `automation:${automation.id}`,
      event: automation.trigger.event as HookEvent,
      matcher: automation.trigger.matcher,
      command: `${automation.action.command} ${MARKER}:${automation.id}`,
      timeout: automation.action.timeout,
      isEnabled: true,
      groupIds: automation.groupIds,
      // Скомпилированные сценарии всегда уходят в основной settings.json:
      // локальный файл панель не переписывает.
      source: 'settings' as const,
    }));

  writeHooks(settings, [...manual, ...compiled], ctx.backupDir);
}
