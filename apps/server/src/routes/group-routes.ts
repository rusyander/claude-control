import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  Automation,
  EntityRef,
  Group,
  GroupDraft,
  GroupMember,
  HookEvent,
} from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { readHooks, writeHooks } from '../domains/hooks.ts';
import { applyEntityState, rewriteHooks, type EntityToggleDeps } from '../domains/entity-toggle.ts';
import { applyGroupEnv, existingEnvKeys } from '../domains/env.ts';
import { collectLeafMembers, wouldCreateCycle } from '../domains/group-graph.ts';

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
 * поэтому сценарии перед сохранением компилируются в обычные хуки: то, что
 * пользователь описал как «после вызова скилла запустить проверку», ложится
 * в settings.json как PostToolUse с matcher.
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
    isEnabled: body.isEnabled ?? true,
  });

  app.post<{ Body: GroupDraft }>('/api/groups', (request, reply) => {
    const id = randomUUID();
    // Вложенная группа может замкнуть цикл (A→B→A) — тогда обход состава не
    // завершился бы. Отвергаем ещё до сохранения, а не чиним на обходе.
    if (wouldCreateCycle(ctx.store.getGroups(), id, request.body.members ?? [])) {
      return reply.code(400).send({ error: 'Вложение групп образует цикл' });
    }
    const group: Group = {
      ...withDefaults(request.body),
      id,
      order: ctx.store.getGroups().length,
    };
    return ctx.store.saveGroup(group);
  });

  app.put<{ Params: { id: string }; Body: Group }>('/api/groups/:id', (request, reply) => {
    // Группа не может входить сама в себя ни напрямую, ни через цепочку вложенных
    // — иначе включение/выключение зациклилось бы по ветке.
    if (wouldCreateCycle(ctx.store.getGroups(), request.params.id, request.body.members ?? [])) {
      return reply.code(400).send({ error: 'Вложение групп образует цикл' });
    }
    // Клиент шлёт GroupDraft без поля order, поэтому при правке порядок нельзя
    // сбрасывать в 0 (иначе редактирование любой группы перекидывало бы её в
    // начало списка и сталкивало по order с уже существующей нулевой). Берём
    // прежний order группы, если тело его не прислало.
    const existing = ctx.store.getGroups().find((item) => item.id === request.params.id);
    const previousMembers = existing?.members ?? [];
    const saved = ctx.store.saveGroup({
      ...withDefaults(request.body),
      id: request.params.id,
      order: request.body.order ?? existing?.order ?? 0,
    });
    // Смена состава должна привести отметки disabledByGroup к новому составу,
    // иначе участник, убранный из ВЫКЛЮЧЕННОЙ группы, остался бы заперт её
    // отметкой навсегда (в списках уже не видно, какая группа его держит), а
    // добавленный в выключенную группу — не погас бы.
    reconcileMembers(ctx, saved, previousMembers);
    // Правка переменных у включённой группы применяется сразу: снимаем прежние
    // свои ключи и накладываем заново. Но переприменяем только когда есть за чем:
    // набор env реально изменился ЛИБО группу этим же PUT включили (её ключи
    // были сняты при выключении и их надо вернуть). Правка без изменения env
    // (переименование, смена цвета) не должна зря переписывать settings.json.
    const envChanged = !sameEnv(existing?.env, saved.env);
    if (saved.isEnabled && (envChanged || !existing?.isEnabled)) {
      applyGroupEnvState(ctx, saved, false);
      applyGroupEnvState(ctx, saved, true);
    }
    return saved;
  });

  /**
   * Переключатель группы. Выключение гасит все её участники разом — ради
   * этого группы и заводят: набор правил и скиллов под задачу включается и
   * выключается одним движением.
   *
   * Групповая отметка ставится отдельно от ручной. Поэтому участник, который
   * человек выключил сам, не оживёт при включении группы, а участник двух
   * групп оживёт только когда его отпустят обе.
   */
  app.post<{ Params: { id: string }; Body: { isEnabled: boolean } }>(
    '/api/groups/:id/enabled',
    (request, reply) => {
      const group = ctx.store.getGroups().find((item) => item.id === request.params.id);
      if (!group) return reply.code(404).send({ error: 'Группа не найдена' });

      const { isEnabled } = request.body;
      ctx.store.saveGroup({ ...group, isEnabled });

      let needsHookRewrite = false;

      // Разворачиваем вложенные группы: гасим/зажигаем и потомков по всей ветке,
      // а не только прямых участников. Отметка «погашено этой группой» ставится
      // от id переключаемой группы — так лист, входящий ещё и в другую группу,
      // оживает лишь когда его отпустят все.
      const leaves = collectLeafMembers(ctx.store.getGroups(), group.members);

      // Хук из settings.local.json группе не подчиняется: панель в этот файл не
      // пишет, поэтому выключить его нечем — и `readHooks` честно показывает его
      // включённым. Раньше отметка всё равно ставилась: группа рапортовала «N
      // выключено», а личный хук продолжал срабатывать. Теперь такие участники
      // пропускаются и считаются отдельно, чтобы интерфейс сказал правду.
      const localHookIds = new Set(
        readHooks(ctx.location.paths.settings, ctx.store, ctx.location.paths.settingsLocal)
          .filter((hook) => hook.source === 'settings-local')
          .map((hook) => hook.id),
      );

      let skippedLocalHooks = 0;

      for (const member of leaves) {
        if (member.kind === 'hook' && localHookIds.has(member.id)) {
          skippedLocalHooks += 1;
          continue;
        }

        ctx.store.setGroupDisabled(member.kind, member.id, group.id, !isEnabled);

        const effective = !ctx.store.isDisabled(member.kind, member.id);
        const result = applyEntityState(toggleDeps(ctx), member.kind, member.id, effective);
        needsHookRewrite ||= result.needsHookRewrite;
      }

      // Хуки лежат в одном файле, поэтому перезапись одна на всю группу.
      const hookBackup = needsHookRewrite ? rewriteHooks(toggleDeps(ctx)) : undefined;
      // Переменные окружения группы: включение пишет их в settings.json,
      // выключение — снимает свои, не задев ручные и общие с другой группой.
      const envBackup = applyGroupEnvState(ctx, group, isEnabled);

      return {
        ok: true,
        backupPath: hookBackup ?? envBackup,
        needsRestart: true,
        // Считаем только тех, кого действительно переключили: пропущенные
        // локальные хуки уходят отдельным числом, а не растворяются в общем.
        affected: leaves.length - skippedLocalHooks,
        skippedLocalHooks,
      };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/groups/:id', (request) => {
    // Группа уходит — её отметки должны уйти вместе с ней, иначе участники
    // остались бы погашенными навсегда, без видимой причины.
    const group = ctx.store.getGroups().find((item) => item.id === request.params.id);

    if (group && !group.isEnabled) {
      for (const member of collectLeafMembers(ctx.store.getGroups(), group.members)) {
        ctx.store.setGroupDisabled(member.kind, member.id, group.id, false);

        const effective = !ctx.store.isDisabled(member.kind, member.id);
        applyEntityState(toggleDeps(ctx), member.kind, member.id, effective);
      }
      rewriteHooks(toggleDeps(ctx));
    }

    // Снимаем переменные окружения, которые держала эта группа (кроме общих с
    // другими). Работает и для включённой группы: её ключи не должны пережить её.
    if (group) applyGroupEnvState(ctx, group, false);

    ctx.store.deleteGroup(request.params.id);
    return { ok: true };
  });

  app.get('/api/automations', () => ctx.store.getAutomations());

  app.post<{ Body: Omit<Automation, 'id'> }>('/api/automations', (request) => {
    const automation: Automation = { ...request.body, id: randomUUID() };
    ctx.store.saveAutomation(automation);
    compileAutomations(ctx);
    return automation;
  });

  app.put<{ Params: { id: string }; Body: Automation }>('/api/automations/:id', (request) => {
    const automation = ctx.store.saveAutomation({ ...request.body, id: request.params.id });
    compileAutomations(ctx);
    return automation;
  });

  app.delete<{ Params: { id: string } }>('/api/automations/:id', (request) => {
    ctx.store.deleteAutomation(request.params.id);
    compileAutomations(ctx);
    return { ok: true };
  });
}

/**
 * Переносит включённые сценарии в settings.json. Ранее скомпилированные
 * записи помечены маркером в команде, поэтому их можно отличить от хуков,
 * написанных руками, и пересобрать, не задев чужое.
 */
/** Совпадают ли наборы env двух версий группы (одни ключи и значения). */
function sameEnv(a: Record<string, string> = {}, b: Record<string, string> = {}): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every((key) => a[key] === b[key]);
}

/**
 * Применить или снять переменные окружения группы в settings.json.
 *
 * Включение: пишем ключи группы, но пропускаем те, что уже заданы вручную (есть
 * в settings и не принадлежат ни одной группе) — ручная переменная важнее. Что
 * реально записали, запоминаем за группой.
 *
 * Выключение: снимаем только свои ключи и только те, что больше не держит ни
 * одна другая группа. Поэтому ручные и общие с другой группой ключи остаются.
 */
function applyGroupEnvState(
  ctx: ServerContext,
  group: Group,
  isEnabled: boolean,
): string | undefined {
  const settingsPath = ctx.location.paths.settings;

  if (isEnabled) {
    const manual = new Set(
      existingEnvKeys(settingsPath).filter((key) => !ctx.store.isEnvKeyOwnedByGroup(key)),
    );
    const set: Record<string, string> = {};
    const applied: string[] = [];
    for (const [key, value] of Object.entries(group.env ?? {})) {
      if (manual.has(key)) continue;
      set[key] = value;
      applied.push(key);
    }
    ctx.store.setGroupEnvKeys(group.id, applied);
    return Object.keys(set).length
      ? applyGroupEnv(settingsPath, set, [], ctx.backupDir)
      : undefined;
  }

  const owned = ctx.store.getGroupEnvKeys(group.id);
  ctx.store.setGroupEnvKeys(group.id, []);
  const remove = owned.filter((key) => !ctx.store.isEnvKeyOwnedByGroup(key));
  return remove.length ? applyGroupEnv(settingsPath, {}, remove, ctx.backupDir) : undefined;
}

/**
 * Привести отметки «погашено этой группой» к новому составу после правки PUT.
 *
 * Ушедший из группы участник освобождается от её удержания: снимаем отметку
 * этой группы, и если сущность больше не держит ни другая группа, ни ручное
 * выключение — она оживает на диске (как будто участник вышел из группы).
 * Пришедший в ВЫКЛЮЧЕННУЮ группу участник, симметрично, гасится ею.
 *
 * На диск ходим только когда итог реально сменился — иначе каждая правка имени
 * включённой группы дёргала бы перезапись файлов и плодила резервные копии.
 * Хуки лежат в одном файле, поэтому перезапись одна на всю правку.
 */
function reconcileMembers(ctx: ServerContext, group: Group, previousMembers: GroupMember[]): void {
  const keyOf = (member: EntityRef): string => `${member.kind} ${member.id}`;
  // Сравниваем не прямой состав, а развёрнутые листья: правка вложенной группы
  // добавляет/убирает всех её потомков, и отметки удержания должны идти за ними.
  const groups = ctx.store.getGroups();
  const nextLeaves = collectLeafMembers(groups, group.members);
  const previousLeaves = collectLeafMembers(groups, previousMembers);

  const nextKeys = new Set(nextLeaves.map(keyOf));
  const prevKeys = new Set(previousLeaves.map(keyOf));

  const removed = previousLeaves.filter((member) => !nextKeys.has(keyOf(member)));
  const added = nextLeaves.filter((member) => !prevKeys.has(keyOf(member)));

  let needsHookRewrite = false;

  const reapply = (member: EntityRef, heldByGroup: boolean): void => {
    const before = ctx.store.isDisabled(member.kind, member.id);
    ctx.store.setGroupDisabled(member.kind, member.id, group.id, heldByGroup);
    const after = ctx.store.isDisabled(member.kind, member.id);
    if (before !== after) {
      const result = applyEntityState(toggleDeps(ctx), member.kind, member.id, !after);
      needsHookRewrite ||= result.needsHookRewrite;
    }
  };

  for (const member of removed) reapply(member, false);
  if (!group.isEnabled) for (const member of added) reapply(member, true);

  if (needsHookRewrite) rewriteHooks(toggleDeps(ctx));
}

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
