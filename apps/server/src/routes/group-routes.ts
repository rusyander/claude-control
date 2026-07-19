import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Automation, Group, GroupDraft } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { readHooks, writeHooks } from '../domains/hooks.ts';
import { applyEntityState, rewriteHooks } from '../domains/entity-toggle.ts';

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

  app.post<{ Body: GroupDraft }>('/api/groups', (request) => {
    const group: Group = {
      ...withDefaults(request.body),
      id: randomUUID(),
      order: ctx.store.getGroups().length,
    };
    return ctx.store.saveGroup(group);
  });

  app.put<{ Params: { id: string }; Body: Group }>('/api/groups/:id', (request) =>
    ctx.store.saveGroup({
      ...withDefaults(request.body),
      id: request.params.id,
      order: request.body.order ?? 0,
    }),
  );

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

      for (const member of group.members) {
        ctx.store.setGroupDisabled(member.kind, member.id, group.id, !isEnabled);

        const effective = !ctx.store.isDisabled(member.kind, member.id);
        const result = applyEntityState(ctx, member.kind, member.id, effective);
        needsHookRewrite ||= result.needsHookRewrite;
      }

      // Хуки лежат в одном файле, поэтому перезапись одна на всю группу.
      const backupPath = needsHookRewrite ? rewriteHooks(ctx) : undefined;

      return { ok: true, backupPath, needsRestart: true, affected: group.members.length };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/groups/:id', (request) => {
    // Группа уходит — её отметки должны уйти вместе с ней, иначе участники
    // остались бы погашенными навсегда, без видимой причины.
    const group = ctx.store.getGroups().find((item) => item.id === request.params.id);

    if (group && !group.isEnabled) {
      for (const member of group.members) {
        ctx.store.setGroupDisabled(member.kind, member.id, group.id, false);

        const effective = !ctx.store.isDisabled(member.kind, member.id);
        applyEntityState(ctx, member.kind, member.id, effective);
      }
      rewriteHooks(ctx);
    }

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
const MARKER = '# claude-control:automation';

function compileAutomations(ctx: ServerContext): void {
  const { settings } = ctx.location.paths;
  const manual = readHooks(settings, ctx.store).filter((hook) => !hook.command.includes(MARKER));

  const compiled = ctx.store
    .getAutomations()
    .filter((automation) => automation.isEnabled)
    .map((automation) => ({
      id: `automation:${automation.id}`,
      event: automation.trigger.event as ReturnType<typeof readHooks>[number]['event'],
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
