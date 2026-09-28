import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Group, GroupDraft, GroupScenario } from '@agentdeck/contracts';
import type { ServerContext } from '../context.ts';
import type { EntityToggleDeps } from '../domains/entity-toggle.ts';
import {
  applyGroupEnvState,
  groupDeletionEffect,
  reconcileMembers,
  releaseGroupMembers,
  sameEnv,
  setGroupEnabled,
} from '../domains/group-toggle.ts';
import { hasScenario, isValidTrigger, retireScenarioHooks } from '../domains/group-scenario.ts';
import { migrateGroupWithSkill } from '../domains/groups/path-migration.ts';
import { groupViews } from '../domains/groups/views.ts';
import { assertBindingKeepsPair } from '../domains/groups/choice.ts';
import { GroupRequestError } from '../domains/groups/errors.ts';
import { activateGroupsForCwd } from '../domains/group-activation.ts';
import { wouldCreateCycle } from '../domains/group-graph.ts';
import {
  assertGroupDraft,
  assertGroupNameFree,
  GroupExistsError,
  GroupNotFoundError,
  InvalidGroupDraftError,
} from '../domains/group-draft.ts';
import { codeOf } from '../lib/server-text.ts';
import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';

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
    error instanceof GroupRequestError
  ) {
    return reply
      .code(error.statusCode)
      .send({ error: error.code, message: error.message, ...codeOf(error) });
  }
  throw error;
}

/** Поля записи, которые PUT формы не меняет: у них свои маршруты. */
function keptFields(existing: Group, body: GroupDraft): Partial<Group> {
  return {
    ...(existing.path ? { path: existing.path } : {}),
    ...(existing.knobs ? { knobs: existing.knobs } : {}),
    ...(existing.origin ? { origin: existing.origin } : {}),
    ...(existing.scope ? { scope: existing.scope } : {}),
    ...(body.when === undefined && existing.when !== undefined ? { when: existing.when } : {}),
    // Старая форма группы про ход пути не знает: без этого её сохранение делало сценарий конвейером.
    ...(body.flow === undefined && existing.flow !== undefined ? { flow: existing.flow } : {}),
  };
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
 * Группы и автоматизации — надстройка приложения. Claude Code про них не знает:
 * автоматизация перед сохранением компилируется в хук settings.json, а порядок
 * работы группы живёт в её «Пути» и идёт ходами конвейера.
 */
export function registerGroupRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/groups', () => groupViews(toggleDeps(ctx)));

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
    ...(body.scope ? { scope: body.scope } : {}),
    // Пустое «Когда» — стёртое: поля в записи нет (так же, как у группы без него).
    ...(body.when?.trim() ? { when: body.when.trim() } : {}),
    ...(body.flow ? { flow: body.flow } : {}),
    isEnabled: body.isEnabled ?? true,
  });

  /**
   * Сохранение группы. Сценарий больше не компилируется: старые клиенты ещё шлют
   * `scenario.steps`, и у группы без «Пути» они переносятся в него тем же
   * переносом, что при запуске (`groups/path-migration.ts`) — иначе шаги,
   * набранные в старой форме, молча пропали бы.
   */
  const persist = (group: Group, previousMembers: Group['members'], previous?: Group): Group => {
    const deps = toggleDeps(ctx);
    const ready =
      group.path === undefined && hasScenario(group.scenario)
        ? (migrateGroupWithSkill(deps, group, new Date().toISOString(), previous ?? group)?.group ??
          group)
        : group;
    const saved = ctx.store.saveGroup(ready);
    reconcileMembers(deps, saved, previousMembers);
    retireScenarioHooks(deps);
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
        return reply
          .code(400)
          .send({ error: 'Вложение групп образует цикл', messageCode: 'group-cycle' });
      }
      const invalid = triggerError(body.scenario);
      if (invalid) return reply.code(400).send(invalid);

      const draft = withDefaults(body);
      // Новая ВЫКЛЮЧЕННАЯ группа — спящая: участников она не гасит, пока её не
      // включат и не выключат тумблером (как копия и импорт находки). Иначе
      // черновик агента панели (draft_group) гасил скиллы и правила, которые
      // держит включённая группа или которыми человек пользуется прямо сейчас.
      const dormant = draft.isEnabled ? [] : draft.members;
      const saved = persist({ ...draft, id, order: nextOrder(groups) }, dormant);
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
        return reply
          .code(400)
          .send({ error: 'Вложение групп образует цикл', messageCode: 'group-cycle' });
      }
      const invalid = triggerError(body.scenario);
      if (invalid) return reply.code(400).send(invalid);

      // Скомпилированный скилл держится за группой, а не за телом запроса:
      // клиент про его id не знает, и без этого каждая правка заводила бы новый.
      const scenario = normalizeScenario(body.scenario ?? undefined, existing.scenario);
      // Клиент шлёт GroupDraft без поля order: берём прежний, иначе правка любой
      // группы перекидывала бы её в начало списка.
      const { order } = body as { order?: unknown };

      const next: Group = {
        ...withDefaults(body),
        scenario,
        // Путь, происхождение и область правятся своими маршрутами: форма
        // группы про них не знает, и без этого каждое сохранение их стирало бы.
        ...keptFields(existing, body),
        id: existing.id,
        order: typeof order === 'number' ? order : existing.order,
        // Состояние группы правкой не меняется: включает и выключает только
        // POST /:id/enabled — он же двигает участников. Флаг из тела (форма
        // шлёт сохранённый, телефон и скрипты — что угодно) раньше переключал
        // одну лишь группу: карточка читалась «включено», а её скилл оставался
        // в skills-disabled.
        isEnabled: existing.isEnabled,
      };
      // Привязка глобальной копии к проекту, где действует её оригинал, включила
      // бы там обе группы пары — отказ до записи.
      assertBindingKeepsPair(ctx.location.paths.appData, groups, next);
      const saved = persist(next, existing.members, existing);
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
      if (!group)
        return reply.code(404).send({ error: 'Группа не найдена', messageCode: 'group-not-found' });

      // Состояние обязано прийти явно: домыслить его тут значило бы переключить
      // группу не туда, куда просили, — а это правка настоящего ~/.claude.
      const isEnabled = request.body?.isEnabled;
      if (typeof isEnabled !== 'boolean') {
        return reply
          .code(400)
          .send({ error: 'Не указано состояние группы', messageCode: 'group-state-unspecified' });
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

  /** Что сделает удаление, без записи: карточке подтверждения агента панели. */
  app.get<{ Params: { id: string } }>('/api/groups/:id/delete-effect', (request, reply) => {
    const group = ctx.store.getGroups().find((item) => item.id === request.params.id);
    if (!group) return fail(reply, new GroupNotFoundError(request.params.id));
    return groupDeletionEffect(ctx.store, group);
  });

  app.delete<{ Params: { id: string } }>('/api/groups/:id', (request, reply) => {
    const group = ctx.store.getGroups().find((item) => item.id === request.params.id);
    if (!group) return fail(reply, new GroupNotFoundError(request.params.id));
    const deps = toggleDeps(ctx);
    // Считается ДО удаления: потом ни отметок, ни ключей группы уже не видно.
    // Итог называет сделанное вне state.json — агент панели пересказывает его.
    const effect = groupDeletionEffect(ctx.store, group);

    // Группа уходит — её отметки должны уйти вместе с ней, иначе участники
    // остались бы погашенными навсегда, без видимой причины.
    if (!group.isEnabled) releaseGroupMembers(deps, group);

    // Снимаем переменные окружения, которые держала эта группа (кроме общих с
    // другими). Работает и для включённой группы: её ключи не должны пережить её.
    applyGroupEnvState(deps, group, false);

    ctx.store.deleteGroup(group.id);
    // Скилл сценария остаётся на диске: это обычный скилл, и удалять чужую
    // работу вместе с группой панель не вправе. Уцелевшие триггеры уходят.
    retireScenarioHooks(deps);
    return { ok: true, ...effect };
  });

  // Автоматизаций больше нет: при старте они разово стали хуками и шагами «Хук»
  // (`groups/automation-migration.ts`), сборки в settings.json нет.
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
function triggerError(scenario?: Partial<GroupScenario>): CodedRefusal | undefined {
  if (!scenario?.trigger || isValidTrigger(scenario.trigger)) return undefined;
  return {
    error: 'Выражение триггера не является регулярным выражением',
    messageCode: 'scenario-trigger-not-regex',
  };
}

/** Отказ проверки тела: русская строка в `error` и код для перевода на клиенте. */
interface CodedRefusal {
  error: string;
  messageCode: ServerMessageCode;
}
