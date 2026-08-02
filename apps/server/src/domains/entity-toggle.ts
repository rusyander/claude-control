import type { ClaudePaths, EntityKind, Hook, PermissionDecision } from '@claude-control/contracts';
import type { AppStore } from '../lib/app-store.ts';
import { readRules, saveRule, setRulesEnabled } from './rules.ts';
import { readHooks, writeHooks } from './hooks.ts';
import { setSkillEnabled } from './skills.ts';
import { setMcpServerEnabled } from './mcp.ts';
import { savePermission, deletePermission, setPermissionsEnabled } from './permissions.ts';
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
 * Всё, что домену нужно от окружения: пути активного каталога конфигурации,
 * состояние панели и каталог резервных копий. Та же тройка, что берут соседние
 * домены — собирает её вызывающий, про сборку сервера домен не знает.
 */
export interface EntityToggleDeps {
  paths: ClaudePaths;
  store: AppStore;
  backupDir?: string;
}

/**
 * Поиск хука по идентификатору — с оглядкой на прежний, позиционный.
 *
 * Состав групп и ссылки вида `?id=…`, сделанные до перехода на контентные id,
 * ссылаются на старые значения. Искать только по новому — значит не найти
 * ровно те хуки, которые пользователь настроил раньше.
 */
export function findHook({ paths, store }: EntityToggleDeps, id: string): Hook | undefined {
  const hooks = readHooks(paths.settings, store, paths.settingsLocal);

  return hooks.find((hook) => hook.id === id) ?? hooks.find((hook) => hook.legacyId === id);
}

/** Одно применение состояния: что переключаем и в какое состояние. */
export interface EntityState {
  kind: EntityKind;
  id: string;
  isEnabled: boolean;
}

/**
 * Применить состояние сразу к пачке сущностей — путь группового тумблера.
 *
 * Смысл в файлах, а не в скорости самой по себе: правила лежат в одном
 * `CLAUDE.md`, права — в одном `settings.json`, и поштучный проход читал и
 * переписывал общий файл на КАЖДОГО участника, каждый раз откатывая резервную
 * копию. Здесь такой файл читается один раз и пишется один раз.
 *
 * У правил это ещё и вопрос правильности: их id выводится из заголовка при
 * каждом разборе, поэтому гашение первого из двух ОДНОИМЁННЫХ правил меняло id
 * второго — и до него очередь уже не доходила (см. `setRulesEnabled`).
 *
 * Скиллы и MCP-серверы остаются поштучными: у каждого своя папка или своя
 * секция конфига, общего файла, который стоило бы переписать разом, у них нет.
 * Хуки, как и раньше, применяются одной перезаписью в конце — она за
 * вызывающим (`rewriteHooks`), потому что нужна и после одиночного переключения.
 */
export function applyEntityStates(deps: EntityToggleDeps, states: EntityState[]): ApplyResult {
  const { paths, store, backupDir } = deps;

  const rules = new Map<string, boolean>();
  const permissions = new Map<string, { id: string; isEnabled: boolean }[]>();
  let needsHookRewrite = false;

  for (const state of states) {
    if (state.kind === 'rule') {
      rules.set(state.id, state.isEnabled);
      continue;
    }

    if (state.kind === 'permission') {
      // Локальное право правится в settings.local.json; префикс `local:` файлу
      // неизвестен — снимаем его, как и при поштучной записи.
      const target = isLocalId(state.id) ? paths.settingsLocal : paths.settings;
      const list = permissions.get(target) ?? [];
      list.push({ id: stripLocalPrefix(state.id), isEnabled: state.isEnabled });
      permissions.set(target, list);
      continue;
    }

    needsHookRewrite = applyEntityState(deps, state.kind, state.id, state.isEnabled)
      .needsHookRewrite
      ? true
      : needsHookRewrite;
  }

  if (rules.size > 0) setRulesEnabled(paths.claudeMd, rules, store, backupDir);
  for (const [target, list] of permissions) setPermissionsEnabled(target, list, backupDir);

  return { needsHookRewrite };
}

export function applyEntityState(
  deps: EntityToggleDeps,
  kind: EntityKind,
  id: string,
  isEnabled: boolean,
): ApplyResult {
  const { paths, store, backupDir } = deps;

  // У скиллов и MCP-серверов выключение физическое: перенос папки или
  // секции конфига. Остальное хранится отметкой в состоянии приложения.
  if (kind === 'skill') setSkillEnabled(paths.skills, id, isEnabled);
  if (kind === 'mcp') setMcpServerEnabled(paths.mcpConfig, id, isEnabled, backupDir);

  // Правило физически уезжает в раздел отключённых — перезаписью CLAUDE.md.
  // Состояние передаём явно: при чтении оно берётся из расположения правила в
  // файле, а нам нужно записать то, которое запросили, иначе выключенное
  // правило нечем было бы включить обратно.
  if (kind === 'rule') {
    const rule = readRules(paths.claudeMd, store).find((item) => item.id === id);
    if (rule) saveRule(paths.claudeMd, id, { ...rule, isEnabled }, store, backupDir);
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
        backupDir,
      );
    } else {
      deletePermission(target, bareId, backupDir);
    }
  }

  // Хук выключается удалением из settings.json, поэтому его команду надо
  // запомнить ДО перезаписи файла: после неё брать её будет неоткуда.
  if (kind === 'hook' && !isEnabled) {
    const hook = findHook(deps, id);
    // Локальный хук не запоминаем: панель в settings.local.json не пишет, и
    // выключить его нечем. Снимок же лёг бы в общее состояние без пометки о
    // файле — и первая же перезапись перенесла бы личный хук в settings.json,
    // то есть включила бы его всем, кто читает этот конфиг.
    if (hook && hook.source !== 'settings-local') {
      store.rememberDisabledHook({ ...hook, isEnabled: false });
    }
  }

  return { needsHookRewrite: kind === 'hook' };
}

/**
 * Перезапись хуков по текущему состоянию: выключенный хук просто не попадает
 * в settings.json. Один вызов на всю операцию — читать и писать файл на
 * каждого участника группы незачем.
 */
export function rewriteHooks({ paths, store, backupDir }: EntityToggleDeps): string | undefined {
  const hooks = readHooks(paths.settings, store, paths.settingsLocal);
  const backupPath = writeHooks(paths.settings, hooks, backupDir);

  // Снимок нужен только выключенному хуку: включённый снова лежит в файле.
  // Чистим после записи — иначе включать было бы нечего.
  store.pruneDisabledHooks(hooks.filter((hook) => hook.isEnabled).map((hook) => hook.id));

  return backupPath;
}
