import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
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
import { AUTOMATION_MARKER } from '../domains/compiled-markers.ts';
import {
  assertGroupDraft,
  assertGroupNameFree,
  AutomationNotFoundError,
  GroupExistsError,
  GroupNotFoundError,
  InvalidGroupDraftError,
} from '../domains/group-draft.ts';

/**
 * Что доменные функции переключения берут от контекста. Собираем на каждом
 * обращении, а не один раз при регистрации: каталог конфигурации меняется на
 * лету (`ctx.relocate`), вместе с ним — пути и хранилище состояния.
 */
function toggleDeps(ctx: ServerContext): EntityToggleDeps {
  return { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir };
}

/**
 * Ошибка домена → статус с причиной, как у MCP: черновик не по форме — 400
 * (раньше участник без id или `env` строкой уезжали в state.json как есть, а
 * страница падала на `paths.map`); группы нет — 404, а не молчаливое создание
 * по PUT и не «ok» на DELETE; имя занято — 409: по имени группу находят и
 * удаляют, двух одинаковых карточек быть не должно.
 */
function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof InvalidGroupDraftError ||
    error instanceof GroupNotFoundError ||
    error instanceof GroupExistsError ||
    error instanceof AutomationNotFoundError
  ) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

/** То же имя с точностью до регистра и краёв — так же его сравнивает assertGroupNameFree. */
function sameGroupName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

/** Следующий порядковый номер: за наибольшим, а не «сколько групп» — после удалений это не одно и то же. */
function nextOrder(groups: readonly Group[]): number {
  return groups.reduce((max, group) => Math.max(max, group.order), -1) + 1;
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
  const withDefaults = (body: GroupDraft): Omit<Group, 'id' | 'order'> => ({
    name: body.name,
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

  app.post<{ Body: unknown }>('/api/groups', (request, reply) => {
    try {
      // Fastify отдаёт `undefined` на запрос без тела и `null` на литерал `null`;
      // оба — «нет описания», и отказ на них должен быть 400, а не пятисоткой.
      const body: unknown = request.body ?? {};
      assertGroupDraft(body);
      const groups = ctx.store.getGroups();
      assertGroupNameFree(groups, body.name);

      const id = randomUUID();
      // Вложенная группа может замкнуть цикл (A→B→A) — тогда обход состава не
      // завершился бы. Отвергаем ещё до сохранения, а не чиним на обходе.
      if (wouldCreateCycle(groups, id, body.members ?? [])) {
        return reply.code(400).send({ error: 'Вложение групп образует цикл' });
      }
      const invalid = triggerError(body.scenario);
      if (invalid) return reply.code(400).send({ error: invalid });

      const saved = persist({ ...withDefaults(body), id, order: nextOrder(groups) }, []);
      // Переменные включённой группы применяются сразу при создании. Раньше POST
      // их не трогал: карточка показывала «env: 1», а в settings.json ключа не
      // было до первого выключения-включения — и PUT с тем же env его не
      // приносил (набор не изменился).
      if (saved.isEnabled) applyGroupEnvState(toggleDeps(ctx), saved, true);
      return saved;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/api/groups/:id', (request, reply) => {
    try {
      const body: unknown = request.body ?? {};
      assertGroupDraft(body);
      const groups = ctx.store.getGroups();
      const existing = groups.find((item) => item.id === request.params.id);
      if (!existing) throw new GroupNotFoundError(request.params.id);
      // Имя не менялось (регистр и края не в счёт) — уникальность не проверяем:
      // state.json, записанный до этой проверки, может держать «Dev» и «dev»
      // рядом, и иначе ни одну из них нельзя было бы даже переописать.
      if (!sameGroupName(body.name, existing.name)) {
        assertGroupNameFree(groups, body.name, existing.id);
      }

      // Группа не может входить сама в себя ни напрямую, ни через цепочку вложенных
      // — иначе включение/выключение зациклилось бы по ветке.
      if (wouldCreateCycle(groups, existing.id, body.members ?? [])) {
        return reply.code(400).send({ error: 'Вложение групп образует цикл' });
      }
      const invalid = triggerError(body.scenario);
      if (invalid) return reply.code(400).send({ error: invalid });

      // Скомпилированный скилл держится за группой, а не за телом запроса:
      // клиент про его id не знает, и без этого каждая правка заводила бы новый.
      const scenario = normalizeScenario(body.scenario ?? undefined, existing.scenario);
      // Клиент шлёт GroupDraft без поля order: берём прежний, иначе правка любой
      // группы перекидывала бы её в начало списка.
      const { order } = body as { order?: unknown };

      const saved = persist(
        {
          ...withDefaults(body),
          scenario,
          id: existing.id,
          order: typeof order === 'number' ? order : existing.order,
          // Состояние группы правкой не меняется: включает и выключает только
          // POST /:id/enabled — он же двигает участников. Флаг из тела (форма
          // шлёт сохранённый, телефон и скрипты — что угодно) раньше переключал
          // одну лишь группу: карточка читалась «включено», а её скилл оставался
          // в skills-disabled.
          isEnabled: existing.isEnabled,
        },
        existing.members,
      );
      // Правка переменных у включённой группы применяется сразу: снимаем прежние
      // свои ключи и накладываем заново — но только когда набор реально
      // изменился. Правка без изменения env (переименование, смена цвета) не
      // должна зря переписывать settings.json.
      if (saved.isEnabled && !sameEnv(existing.env, saved.env)) {
        applyGroupEnvState(toggleDeps(ctx), saved, false);
        applyGroupEnvState(toggleDeps(ctx), saved, true);
      }
      return saved;
    } catch (error) {
      return fail(reply, error);
    }
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

  app.delete<{ Params: { id: string } }>('/api/groups/:id', (request, reply) => {
    const group = ctx.store.getGroups().find((item) => item.id === request.params.id);
    if (!group) return fail(reply, new GroupNotFoundError(request.params.id));
    const deps = toggleDeps(ctx);

    // Группа уходит — её отметки должны уйти вместе с ней, иначе участники
    // остались бы погашенными навсегда, без видимой причины.
    if (!group.isEnabled) releaseGroupMembers(deps, group);

    // Снимаем переменные окружения, которые держала эта группа (кроме общих с
    // другими). Работает и для включённой группы: её ключи не должны пережить её.
    applyGroupEnvState(deps, group, false);

    ctx.store.deleteGroup(group.id);
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

  const hasAutomation = (id: string): boolean =>
    ctx.store.getAutomations().some((item) => item.id === id);

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
      // Сначала тело (400), потом адресат (404) — тот же порядок, что у PUT группы:
      // пустой запрос получает один ответ независимо от того, есть ли такой id.
      // Правка неизвестного сценария — 404, а не создание под чужим id.
      const invalid = automationError(request.body);
      if (invalid) return reply.code(400).send({ error: invalid });
      if (!hasAutomation(request.params.id)) {
        return fail(reply, new AutomationNotFoundError(request.params.id));
      }

      const automation = ctx.store.saveAutomation({
        ...(request.body as Automation),
        id: request.params.id,
      });
      compileAutomations(ctx);
      return automation;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/automations/:id', (request, reply) => {
    if (!hasAutomation(request.params.id)) {
      return fail(reply, new AutomationNotFoundError(request.params.id));
    }
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
function compileAutomations(ctx: ServerContext): void {
  const { settings } = ctx.location.paths;
  const manual = readHooks(settings, ctx.store).filter(
    (hook) => !hook.command.includes(AUTOMATION_MARKER),
  );

  const compiled = ctx.store
    .getAutomations()
    .filter((automation) => automation.isEnabled)
    .map((automation) => ({
      id: `automation:${automation.id}`,
      event: automation.trigger.event as HookEvent,
      matcher: automation.trigger.matcher,
      command: `${automation.action.command} ${AUTOMATION_MARKER}:${automation.id}`,
      timeout: automation.action.timeout,
      isEnabled: true,
      groupIds: automation.groupIds,
      // Скомпилированные сценарии всегда уходят в основной settings.json:
      // локальный файл панель не переписывает.
      source: 'settings' as const,
    }));

  writeHooks(settings, [...manual, ...compiled], ctx.backupDir);
}
