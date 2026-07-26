import type { EntityKind, Hook, PermissionDecision } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { readRules, saveRule } from './rules.ts';
import { readHooks, writeHooks } from './hooks.ts';
import { setSkillEnabled } from './skills.ts';
import { setMcpServerEnabled } from './mcp.ts';
import { savePermission, deletePermission } from './permissions.ts';
import { isLocalId, stripLocalPrefix } from '../lib/settings-source.ts';

/**
 * Включение и выключение сущности — то, что происходит на диске.
 *
 * Вынесено из маршрута, потому что путей теперь два: одиночный переключатель
 * и переключатель группы, который проходит по всем её участникам. Логика
 * обязана быть общей — иначе группа выключала бы скилл иначе, чем это делает
 * сам раздел «Скиллы».
 *
 * Отметки состояния сюда не входят: их ставит вызывающий (вручную — в
 * `disabled`, группой — в `disabledByGroup`), а здесь применяется уже
 * посчитанный итог.
 */

/**
 * Хуки и правила живут внутри общих файлов, поэтому применяются не поштучно,
 * а перезаписью файла целиком. Для группы это значит одну перезапись в конце
 * вместо перезаписи на каждого участника.
 */
export interface ApplyResult {
  needsHookRewrite: boolean;
}

/**
 * Поиск хука по идентификатору — с оглядкой на прежний, позиционный.
 *
 * Состав групп и ссылки вида `?id=…`, сделанные до перехода на контентные id,
 * ссылаются на старые значения. Искать только по новому — значит не найти
 * ровно те хуки, которые пользователь настроил раньше.
 */
export function findHook(ctx: ServerContext, id: string): Hook | undefined {
  const { settings, settingsLocal } = ctx.location.paths;
  const hooks = readHooks(settings, ctx.store, settingsLocal);

  return hooks.find((hook) => hook.id === id) ?? hooks.find((hook) => hook.legacyId === id);
}

export function applyEntityState(
  ctx: ServerContext,
  kind: EntityKind,
  id: string,
  isEnabled: boolean,
): ApplyResult {
  const paths = ctx.location.paths;

  // У скиллов и MCP-серверов выключение физическое: перенос папки или
  // секции конфига. Остальное хранится отметкой в состоянии приложения.
  if (kind === 'skill') setSkillEnabled(paths.skills, id, isEnabled);
  if (kind === 'mcp') setMcpServerEnabled(paths.mcpConfig, id, isEnabled, ctx.backupDir);

  // Правило физически уезжает в раздел отключённых — перезаписью CLAUDE.md.
  // Состояние передаём явно: при чтении оно берётся из расположения правила в
  // файле, а нам нужно записать то, которое запросили, иначе выключенное
  // правило нечем было бы включить обратно.
  if (kind === 'rule') {
    const rule = readRules(paths.claudeMd, ctx.store).find((item) => item.id === id);
    if (rule) saveRule(paths.claudeMd, id, { ...rule, isEnabled }, ctx.store, ctx.backupDir);
  }

  // Право — паттерн в settings.json → permissions.<decision>. Гашение группой
  // должно физически убирать его из списка, включение — возвращать: иначе
  // группа лишь помечала бы право у себя, а Claude Code продолжал бы его
  // применять. Всё нужное для реконструкции лежит в id (`[local:]decision:pattern`),
  // поэтому выключенное право есть чем вернуть. Локальное право правим в
  // settings.local.json, префикс `local:` файлу неизвестен — снимаем.
  if (kind === 'permission') {
    const target = isLocalId(id) ? paths.settingsLocal : paths.settings;
    const bareId = stripLocalPrefix(id);

    if (isEnabled) {
      const [decision, ...rest] = bareId.split(':');
      savePermission(
        target,
        null,
        { decision: decision as PermissionDecision, pattern: rest.join(':'), groupIds: [] },
        ctx.backupDir,
      );
    } else {
      deletePermission(target, bareId, ctx.backupDir);
    }
  }

  // Хук выключается удалением из settings.json, поэтому его команду надо
  // запомнить ДО перезаписи файла: после неё брать её будет неоткуда.
  if (kind === 'hook' && !isEnabled) {
    const hook = findHook(ctx, id);
    // Локальный хук не запоминаем: панель в settings.local.json не пишет, и
    // выключить его нечем. Снимок же лёг бы в общее состояние без пометки о
    // файле — и первая же перезапись перенесла бы личный хук в settings.json,
    // то есть включила бы его всем, кто читает этот конфиг.
    if (hook && hook.source !== 'settings-local') {
      ctx.store.rememberDisabledHook({ ...hook, isEnabled: false });
    }
  }

  return { needsHookRewrite: kind === 'hook' };
}

/**
 * Перезапись хуков по текущему состоянию: выключенный хук просто не попадает
 * в settings.json. Один вызов на всю операцию — читать и писать файл на
 * каждого участника группы незачем.
 */
export function rewriteHooks(ctx: ServerContext): string | undefined {
  const { settings, settingsLocal } = ctx.location.paths;
  const hooks = readHooks(settings, ctx.store, settingsLocal);
  const backupPath = writeHooks(settings, hooks, ctx.backupDir);

  // Снимок нужен только выключенному хуку: включённый снова лежит в файле.
  // Чистим после записи — иначе включать было бы нечего.
  ctx.store.pruneDisabledHooks(hooks.filter((hook) => hook.isEnabled).map((hook) => hook.id));

  return backupPath;
}
