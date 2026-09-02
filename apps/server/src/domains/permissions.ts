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

// Инструмент необязателен: `mcp__server` — право на весь сервер, оно тоже
// принадлежит вкладке MCP, а раньше туда не попадало.
const MCP_PATTERN = /^mcp__([^_]+(?:[^_]|_(?!_))*)(?:__(.+))?$/;

const DECISIONS: readonly PermissionDecision[] = ['allow', 'ask', 'deny'];

/** Черновик права не прошёл проверку: неизвестное решение или пустой шаблон. */
export class InvalidPermissionError extends Error {
  statusCode = 400;
  code = 'invalid_permission';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidPermissionError';
  }
}

/** Такое право уже есть в этом файле: ни файл, ни список не изменились бы. */
export class PermissionExistsError extends Error {
  statusCode = 409;
  code = 'permission_exists';

  constructor(pattern: string) {
    super(`Правило «${pattern}» с таким решением уже есть`);
    this.name = 'PermissionExistsError';
  }
}

/** Права с таким id в файле нет — нечего править, переносить или удалять. */
export class PermissionNotFoundError extends Error {
  statusCode = 404;
  code = 'permission_not_found';

  constructor(id: string) {
    super(`Право «${id}» не найдено`);
    this.name = 'PermissionNotFoundError';
  }
}

/**
 * Тело запроса как черновик. Маршруты прав без схемы, поэтому решение
 * проверяется здесь: `decision: "zzz"` заводил в settings.json список, которого
 * Claude Code не знает. Шаблон обрезается — пробелы по краям не часть правила.
 */
export function assertPermissionDraft(draft: unknown): PermissionDraft {
  const value = (draft ?? {}) as Partial<PermissionDraft>;
  const pattern = typeof value.pattern === 'string' ? value.pattern.trim() : '';
  if (!pattern) throw new InvalidPermissionError('Пустой шаблон права');
  if (!DECISIONS.includes(value.decision as PermissionDecision)) {
    throw new InvalidPermissionError(`Неизвестное решение: ${String(value.decision)}`);
  }
  const groupIds = Array.isArray(value.groupIds)
    ? value.groupIds.filter((id): id is string => typeof id === 'string')
    : [];

  return { pattern, decision: value.decision as PermissionDecision, groupIds };
}

/** Есть ли право `decision:pattern` в этом файле настроек. */
export function hasPermission(settingsPath: string, ruleId: string): boolean {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const [decision, ...rest] = ruleId.split(':');

  return (settings.permissions?.[decision as PermissionDecision] ?? []).includes(rest.join(':'));
}

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
      rules.push(ruleOf(id, pattern, decision, source, store, true));
    }
  }

  return rules;
}

function ruleOf(
  id: string,
  pattern: string,
  decision: PermissionDecision,
  source: SettingsSource,
  store: AppStore,
  isEnabled: boolean,
): PermissionRule {
  const mcp = MCP_PATTERN.exec(pattern);
  return {
    id,
    pattern,
    decision,
    mcpServer: mcp?.[1],
    mcpTool: mcp?.[2],
    groupIds: store.getGroupIdsFor('permission', id),
    source,
    isEnabled,
  };
}

/**
 * Выключенные права, которых в файлах уже нет. Выключение права — это его
 * удаление из списка settings.json (иначе Claude Code продолжал бы его
 * применять), а всё нужное для возврата лежит в самом id (`[local:]decision:
 * pattern`). Без подмешивания право, погашенное группой или вручную, исчезало
 * бы со своей страницы: группа говорила «5 участников», список показывал 4, и
 * включить его обратно можно было только через тумблер группы.
 */
function rememberedPermissions(
  store: AppStore,
  inFile: ReadonlySet<string>,
  hasLocal: boolean,
): PermissionRule[] {
  const rules: PermissionRule[] = [];

  for (const id of store.getDisabledIds('permission')) {
    if (inFile.has(id)) continue;
    const local = id.startsWith(LOCAL_ID_PREFIX);
    // Локальное право без локального файла показать некуда — и нечем включить.
    if (local && !hasLocal) continue;

    const [decision, ...rest] = (local ? id.slice(LOCAL_ID_PREFIX.length) : id).split(':');
    const pattern = rest.join(':');
    if (!pattern || !DECISIONS.includes(decision as PermissionDecision)) continue;

    rules.push(
      ruleOf(
        id,
        pattern,
        decision as PermissionDecision,
        local ? 'settings-local' : 'settings',
        store,
        false,
      ),
    );
  }

  return rules;
}

/**
 * Все действующие права. Локальный файл читается наравне с основным — иначе
 * список врал бы: запрет, живущий в `settings.local.json`, действует ровно
 * так же, а в панели его не было видно вовсе. Выключенные подмешиваются из
 * отметок панели (`rememberedPermissions`).
 */
export function readPermissions(
  settingsPath: string,
  store: AppStore,
  localPath?: string,
): PermissionRule[] {
  const own = readPermissionsFrom(settingsPath, store, 'settings');
  const local = localPath ? readPermissionsFrom(localPath, store, 'settings-local') : [];
  const inFile = new Set([...own, ...local].map((rule) => rule.id));
  const remembered = rememberedPermissions(store, inFile, Boolean(localPath));

  return [
    ...own,
    ...remembered.filter((rule) => rule.source === 'settings'),
    ...local,
    ...remembered.filter((rule) => rule.source === 'settings-local'),
  ];
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
  // Имя копии, когда basename файла не уникален (settings.json ПРОЕКТА):
  // без него копия проекта делила бы имя, ротацию и восстановление с
  // пользовательской (`projectBackupName`).
  backupName?: string,
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

  // Новое правило встаёт на своё место по алфавиту, но соседей не трогает:
  // повторное сохранение (переезд, дубль) ничего не переупорядочивает, а
  // список, выстроенный руками, остаётся в порядке хозяина (`insertSorted`).
  const target = (settings.permissions[draft.decision] ??= []);
  insertSorted(target, draft.pattern);

  return writeJsonFile(settingsPath, settings, { backupDir, backupName });
}

/**
 * Вставка шаблона на алфавитное место БЕЗ пересортировки остального. `sort()`
 * всего списка переупорядочивал бы правила, выстроенные человеком руками: одно
 * выключение-включение группы оставляло в settings.json дифф, которого никто не
 * просил. На уже отсортированном списке результат тот же, что и у `sort()`.
 */
function insertSorted(list: string[], pattern: string): void {
  if (list.includes(pattern)) return;
  const at = list.findIndex((item) => item > pattern);
  if (at < 0) list.push(pattern);
  else list.splice(at, 0, pattern);
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
  backupName?: string,
): string | undefined {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const [decision, ...rest] = ruleId.split(':');
  const pattern = rest.join(':');
  const list = settings.permissions?.[decision as PermissionDecision];

  // Нечего удалять — нечего и переписывать: иначе каждое такое удаление
  // оставляло резервную копию неизменённого файла.
  if (!list?.includes(pattern) || !settings.permissions) return undefined;

  settings.permissions[decision as PermissionDecision] = list.filter((item) => item !== pattern);

  return writeJsonFile(settingsPath, settings, { backupDir, backupName });
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
      insertSorted((settings.permissions[decision] ??= []), pattern);
    } else {
      const list = settings.permissions[decision];
      if (list) settings.permissions[decision] = list.filter((item) => item !== pattern);
    }
  }

  if (JSON.stringify(settings.permissions) === before) return undefined;

  return writeJsonFile(settingsPath, settings, { backupDir });
}
