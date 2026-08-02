import { statSync } from 'node:fs';
import type {
  PermissionDecision,
  PermissionDraft,
  PermissionRule,
  SettingsSource,
} from '@claude-control/contracts';
import { readJsonFile, writeJsonFile } from '../lib/safe-io.ts';
import { LOCAL_ID_PREFIX, isLocalId, stripLocalPrefix } from '../lib/settings-source.ts';
import type { AppStore } from '../lib/app-store.ts';

/**
 * Правила доступа из settings.json. Приоритет в Claude Code: deny > ask > allow,
 * поэтому одно и то же правило в разных списках ведёт себя по-разному — в
 * интерфейсе это показывается явно, чтобы не ловить сюрпризы.
 *
 * Инструменты MCP выглядят как `mcp__<сервер>__<инструмент>` — разбираем их
 * на части, чтобы правила можно было фильтровать по серверу.
 */

interface RawSettings {
  permissions?: Partial<Record<PermissionDecision, string[]>>;
  [key: string]: unknown;
}

const MCP_PATTERN = /^mcp__([^_]+(?:[^_]|_(?!_))*)__(.+)$/;

function readPermissionsFrom(
  settingsPath: string,
  store: AppStore,
  source: SettingsSource,
): PermissionRule[] {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const rules: PermissionRule[] = [];
  const prefix = source === 'settings-local' ? LOCAL_ID_PREFIX : '';

  for (const decision of ['allow', 'ask', 'deny'] as const) {
    for (const pattern of settings.permissions?.[decision] ?? []) {
      const id = `${prefix}${decision}:${pattern}`;
      const mcp = MCP_PATTERN.exec(pattern);

      rules.push({
        id,
        pattern,
        decision,
        mcpServer: mcp?.[1],
        mcpTool: mcp?.[2],
        groupIds: store.getGroupIdsFor('permission', id),
        source,
      });
    }
  }

  return rules;
}

/**
 * Все действующие права. Локальный файл читается наравне с основным — иначе
 * список врал бы: запрет, живущий в `settings.local.json`, действует ровно
 * так же, а в панели его не было видно вовсе.
 */
export function readPermissions(
  settingsPath: string,
  store: AppStore,
  localPath?: string,
): PermissionRule[] {
  const own = readPermissionsFrom(settingsPath, store, 'settings');
  if (!localPath) return own;

  return [...own, ...readPermissionsFrom(localPath, store, 'settings-local')];
}

/** Что читателю охраняемых шаблонов нужно знать прямо сейчас. */
export interface GuardedPatternsSource {
  settings: string;
  settingsLocal?: string;
  store: AppStore;
}

/**
 * Читатель охраняемых шаблонов — всего, что пользователь просил спрашивать или
 * запрещать. Спрашивается это на КАЖДЫЙ вызов инструмента при включённом
 * автоподтверждении, а разбор обоих файлов настроек на каждый вызов — работа
 * заметная и совершенно лишняя: между двумя вызовами файл обычно тот же.
 *
 * Кэш держится на слепке самих файлов (время правки, размер, путь), а не на
 * времени жизни. Это важнее, чем кажется: правило `deny`, добавленное руками в
 * `settings.json` мимо панели, обязано действовать сразу, а не «через минуту».
 * Слепок снимается двумя `stat`, и это на порядки дешевле разбора JSON.
 *
 * Путь тоже входит в слепок: каталог конфигурации меняется на лету, и после
 * переключения кэш от прежнего каталога отвечал бы за чужие права.
 */
export function createGuardedPatternsReader(read: () => GuardedPatternsSource): () => string[] {
  let stamp: string | undefined;
  let patterns: string[] = [];

  const stampOf = (path: string | undefined): string => {
    if (!path) return '';
    try {
      const stats = statSync(path);
      return `${path}:${stats.mtimeMs}:${stats.size}`;
    } catch {
      // Файла нет — это тоже состояние, и его надо отличать от «был и стал другим».
      return `${path}:нет`;
    }
  };

  return () => {
    const { settings, settingsLocal, store } = read();
    const current = `${stampOf(settings)}|${stampOf(settingsLocal)}`;
    if (current === stamp) return patterns;

    patterns = readPermissions(settings, store, settingsLocal)
      .filter((rule) => rule.decision !== 'allow')
      .map((rule) => rule.pattern);
    stamp = current;

    return patterns;
  };
}

export function savePermission(
  settingsPath: string,
  ruleId: string | null,
  draft: PermissionDraft,
  backupDir?: string,
): string | undefined {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  settings.permissions ??= {};

  // Правило может переезжать между списками, поэтому сначала убираем старое.
  if (ruleId) {
    const [oldDecision, ...rest] = ruleId.split(':');
    const oldPattern = rest.join(':');
    const list = settings.permissions[oldDecision as PermissionDecision];
    if (list) {
      settings.permissions[oldDecision as PermissionDecision] = list.filter(
        (item) => item !== oldPattern,
      );
    }
  }

  // Сортируем только когда реально добавили правило: список приложение и так
  // держит отсортированным, поэтому повторное сохранение (переезд, дубль)
  // не нужно переупорядочивать — незачем трогать порядок, который уже на месте.
  const target = (settings.permissions[draft.decision] ??= []);
  if (!target.includes(draft.pattern)) {
    target.push(draft.pattern);
    target.sort();
  }

  return writeJsonFile(settingsPath, settings, { backupDir });
}

/**
 * Перенос права в противоположный файл настроек: удаляем из источника и пишем
 * в другой. Источник определяется префиксом id (`local:` → settings.local.json,
 * иначе settings.json). Переиспользует delete/save — своей логики записи нет.
 * Возвращает путь резервной копии последней записи.
 */
export function movePermission(
  settingsPath: string,
  settingsLocalPath: string,
  ruleId: string,
  backupDir?: string,
): string | undefined {
  const fromLocal = isLocalId(ruleId);
  const bareId = stripLocalPrefix(ruleId);
  const [decision, ...rest] = bareId.split(':');
  const pattern = rest.join(':');

  const sourcePath = fromLocal ? settingsLocalPath : settingsPath;
  const targetPath = fromLocal ? settingsPath : settingsLocalPath;

  deletePermission(sourcePath, bareId, backupDir);
  return savePermission(
    targetPath,
    null,
    { pattern, decision: decision as PermissionDecision, groupIds: [] },
    backupDir,
  );
}

export function deletePermission(
  settingsPath: string,
  ruleId: string,
  backupDir?: string,
): string | undefined {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const [decision, ...rest] = ruleId.split(':');
  const pattern = rest.join(':');
  const list = settings.permissions?.[decision as PermissionDecision];

  if (list && settings.permissions) {
    settings.permissions[decision as PermissionDecision] = list.filter((item) => item !== pattern);
  }

  return writeJsonFile(settingsPath, settings, { backupDir });
}

/**
 * Пакетное включение и выключение прав в ОДНОМ файле настроек: чтение одно,
 * запись одна, резервная копия одна. Нужно групповому тумблеру — раньше каждое
 * право группы читало и переписывало `settings.json` само.
 *
 * Идентификатор права — `decision:pattern`, всё нужное для восстановления в нём
 * и лежит: выключение убирает шаблон из своего списка, включение возвращает.
 * Списки держатся отсортированными, как и при поштучном сохранении. Ничего не
 * изменилось — файл не трогаем.
 */
export function setPermissionsEnabled(
  settingsPath: string,
  states: ReadonlyArray<{ id: string; isEnabled: boolean }>,
  backupDir?: string,
): string | undefined {
  if (states.length === 0) return undefined;

  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const before = JSON.stringify(settings.permissions ?? {});
  settings.permissions ??= {};

  for (const { id, isEnabled } of states) {
    const [rawDecision, ...rest] = id.split(':');
    const decision = rawDecision as PermissionDecision;
    const pattern = rest.join(':');
    if (!pattern) continue;

    if (isEnabled) {
      const list = (settings.permissions[decision] ??= []);
      if (!list.includes(pattern)) {
        list.push(pattern);
        list.sort();
      }
    } else {
      const list = settings.permissions[decision];
      if (list) settings.permissions[decision] = list.filter((item) => item !== pattern);
    }
  }

  if (JSON.stringify(settings.permissions) === before) return undefined;

  return writeJsonFile(settingsPath, settings, { backupDir });
}
