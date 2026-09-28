import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  PermissionDecision,
  PermissionDraft,
  PermissionRule,
  SettingsSource,
} from '@agentdeck/contracts';
import { readJsonFile, writeJsonFile } from '../lib/safe-io.ts';
import { LOCAL_ID_PREFIX, isLocalId, stripLocalPrefix } from '../lib/settings-source.ts';
import type { AppStore, PermissionFilePlaces, PermissionPatternPlace } from '../lib/app-store.ts';
import { coded } from '../lib/server-text.ts';
import { permissionPatternWellFormed } from '@agentdeck/contracts/permission-pattern';

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
    coded(this, 'permission-rule-exists', { pattern });
    this.name = 'PermissionExistsError';
  }
}

/** Права с таким id в файле нет — нечего править, переносить или удалять. */
export class PermissionNotFoundError extends Error {
  statusCode = 404;
  code = 'permission_not_found';

  constructor(id: string) {
    super(`Право «${id}» не найдено`);
    coded(this, 'permission-not-found', { id });
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
  if (!pattern)
    throw coded(new InvalidPermissionError('Пустой шаблон права'), 'permission-pattern-empty');
  // Шаблон, который Claude Code не разберёт как уточнение, молча не сработает.
  // Проверка та же, что у формы массового ввода, и повторяет разбор CLI.
  if (!permissionPatternWellFormed(pattern)) {
    throw coded(
      new InvalidPermissionError(
        `В шаблоне «${pattern}» скобка без пары. Уточнение пишется так: Bash(git status:*)`,
      ),
      'permission-pattern-unbalanced',
      { pattern },
    );
  }
  if (!DECISIONS.includes(value.decision as PermissionDecision)) {
    throw coded(
      new InvalidPermissionError(`Неизвестное решение: ${String(value.decision)}`),
      'permission-decision-unknown',
      { decision: String(value.decision) },
    );
  }
  const groupIds = Array.isArray(value.groupIds)
    ? value.groupIds.filter((id): id is string => typeof id === 'string')
    : [];

  return { pattern, decision: value.decision as PermissionDecision, groupIds };
}

/**
 * Убрать шаблон из списка решения. Список, который эта запись опустошила,
 * уходит из файла целиком: право, добавленное в отсутствовавший список и потом
 * выключенное или удалённое, оставляло в settings.json `"ask": []` — файл не
 * возвращался к прежним байтам. Пустой список, положенный человеком, не трогаем.
 */
function withoutPattern(
  permissions: Partial<Record<PermissionDecision, string[]>>,
  decision: PermissionDecision,
  pattern: string,
): void {
  const list = permissions[decision];
  if (!list) return;
  const next = list.filter((item) => item !== pattern);
  if (next.length === 0 && list.length > 0) delete permissions[decision];
  else permissions[decision] = next;
}

/**
 * Тот же довод уровнем выше: `permissions`, опустевший от ЭТОЙ записи, уходит
 * целиком — право, добавленное в файл без этого ключа и потом удалённое,
 * оставляло `"permissions": {}`. Пустой объект, положенный человеком, остаётся:
 * `wasEmpty` — его вид до записи.
 */
function dropEmptiedPermissions(settings: RawSettings, wasEmpty: boolean): void {
  if (!wasEmpty && settings.permissions && Object.keys(settings.permissions).length === 0) {
    delete settings.permissions;
  }
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
  // Правка в том же списке — на месте: удалённый и заведённый заново ключ
  // встал бы в конец `permissions`, и файл получил бы дифф порядка.
  if (ruleId) {
    const [oldDecision, ...rest] = ruleId.split(':');
    const oldPattern = rest.join(':');
    const sameList = settings.permissions[draft.decision];
    if (oldDecision === draft.decision && sameList) {
      settings.permissions[draft.decision] = sameList.filter((item) => item !== oldPattern);
    } else {
      withoutPattern(settings.permissions, oldDecision as PermissionDecision, oldPattern);
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

  withoutPattern(settings.permissions, decision as PermissionDecision, pattern);
  dropEmptiedPermissions(settings, false);

  return writeJsonFile(settingsPath, settings, { backupDir, backupName });
}

/**
 * Пакетное включение и выключение прав в ОДНОМ файле настроек: чтение одно,
 * запись одна, резервная копия одна. Нужно групповому тумблеру — раньше каждое
 * право группы читало и переписывало `settings.json` само.
 *
 * Идентификатор права — `decision:pattern`, выключение убирает шаблон из своего
 * списка, включение возвращает. Ничего не изменилось — файл не трогаем.
 *
 * Байт в байт туда и обратно (F-270, F-271) держится на памяти панели (`places`,
 * по файлу): выключение запоминает соседей шаблона и позицию снятого контейнера,
 * включение ставит шаблон и контейнер туда же и помечает, какие контейнеры
 * завело само. Снимается при выключении только заведённое панелью; контейнер
 * человека (`"permissions": {}`, `"deny": []`) остаётся. Без памяти (нет
 * `places` или запись о файле пуста) — прежнее правило: уходит опустевшее этой
 * записью, шаблон встаёт на алфавитное место.
 */
export function setPermissionsEnabled(
  settingsPath: string,
  states: ReadonlyArray<{ id: string; isEnabled: boolean }>,
  backupDir?: string,
  places?: PermissionPlacesBook,
): string | undefined {
  if (states.length === 0) return undefined;

  const book = resolve(settingsPath);
  const memory: PermissionFilePlaces = places?.getPermissionPlaces(book) ?? {};
  let settings = readJsonFile<RawSettings>(settingsPath, {});
  const before = JSON.stringify(settings.permissions ?? {});
  const hadKey = settings.permissions !== undefined;
  const listsBefore = new Set(Object.keys(settings.permissions ?? {}));
  // Соседи снятого шаблона — по списку ДО этой записи: снятые пачкой соседи
  // иначе оба числились бы «первыми», и включение переставляло бы их.
  const original = structuredClone(settings.permissions ?? {});

  for (const { id, isEnabled } of states) {
    const [rawDecision, ...rest] = id.split(':');
    const decision = rawDecision as PermissionDecision;
    const pattern = rest.join(':');
    if (!pattern) continue;

    if (isEnabled) {
      settings = withContainers(settings, decision, memory, hadKey, listsBefore);
      insertAtPlace(settings.permissions![decision]!, pattern, memory.patterns?.[id]);
      if (memory.patterns) delete memory.patterns[id];
    } else {
      removeAtPlace(settings, decision, pattern, id, memory, original[decision]);
    }
  }

  const changed = JSON.stringify(settings.permissions ?? {}) !== before;
  if (!changed && hadKey === (settings.permissions !== undefined)) return undefined;
  settings = dropPanelPermissions(settings, before === '{}', memory);

  const backup = writeJsonFile(settingsPath, settings, { backupDir });
  places?.setPermissionPlaces(book, isEmptyMemory(memory) ? undefined : memory);
  return backup;
}

/** Где панель держит память о контейнерах и местах прав — состояние панели. */
export type PermissionPlacesBook = Pick<AppStore, 'getPermissionPlaces' | 'setPermissionPlaces'>;

/** Вставить ключ на позицию: новый объект, прочие ключи в прежнем порядке. */
function withKeyAt<T>(
  source: Record<string, T>,
  key: string,
  value: T,
  at: number | undefined,
): Record<string, T> {
  const entries = Object.entries(source);
  const index = at === undefined ? entries.length : Math.min(Math.max(at, 0), entries.length);
  entries.splice(index, 0, [key, value]);
  return Object.fromEntries(entries);
}

/**
 * Контейнеры под включаемое право. Недостающий заводится на место, где стоял
 * до выключения (или в конец), и помечается заведённым панелью; бывший до
 * этой записи и не помеченный — человеческим.
 */
function withContainers(
  settings: RawSettings,
  decision: PermissionDecision,
  memory: PermissionFilePlaces,
  hadKey: boolean,
  listsBefore: ReadonlySet<string>,
): RawSettings {
  const owners = (memory.owners ??= {});
  let next = settings;
  if (next.permissions === undefined) {
    next = withKeyAt(next, 'permissions', {}, memory.at?.permissions) as RawSettings;
    owners.permissions = 'panel';
    if (memory.at) delete memory.at.permissions;
  } else if (hadKey) owners.permissions ??= 'human';

  const lists = next.permissions!;
  if (lists[decision] === undefined) {
    next.permissions = withKeyAt<string[]>(
      lists as Record<string, string[]>,
      decision,
      [],
      memory.at?.[decision],
    );
    owners[decision] = 'panel';
    if (memory.at) delete memory.at[decision];
  } else if (listsBefore.has(decision)) owners[decision] ??= 'human';
  return next;
}

/**
 * Шаблон — между прежними соседями: сначала перед тем, кто стоял после него,
 * потом после того, кто стоял до, потом на прежнюю позицию. Так поштучное
 * включение соседей в любом порядке восстанавливает порядок, выстроенный
 * человеком. Места нет в памяти — алфавитное место (`insertSorted`).
 */
function insertAtPlace(
  list: string[],
  pattern: string,
  place: PermissionPatternPlace | undefined,
): void {
  if (list.includes(pattern)) return;
  if (!place) {
    insertSorted(list, pattern);
    return;
  }
  const next = place.before === null ? -1 : list.indexOf(place.before);
  const previous = place.after === null ? -1 : list.indexOf(place.after);
  let at = Math.min(place.index, list.length);
  if (next >= 0) at = next;
  else if (previous >= 0) at = previous + 1;
  list.splice(at, 0, pattern);
}

/**
 * Снять шаблон, запомнив его место. Опустевший список уходит, если его завела
 * панель или о нём ничего не известно (прежнее правило), и тогда запоминается
 * его позиция; список человека остаётся пустым. Пустой список, в котором
 * шаблона и не было, не трогается.
 */
function removeAtPlace(
  settings: RawSettings,
  decision: PermissionDecision,
  pattern: string,
  id: string,
  memory: PermissionFilePlaces,
  original: readonly string[] | undefined,
): void {
  const lists = settings.permissions;
  const list = lists?.[decision];
  const index = list?.indexOf(pattern) ?? -1;
  if (!lists || !list || index < 0) return;

  const source = original?.includes(pattern) ? original : list;
  const at = source.indexOf(pattern);
  (memory.patterns ??= {})[id] = {
    after: source[at - 1] ?? null,
    before: source[at + 1] ?? null,
    index: at,
  };
  list.splice(index, 1);
  if (list.length > 0 || memory.owners?.[decision] === 'human') return;
  (memory.at ??= {})[decision] = Object.keys(lists).indexOf(decision);
  delete lists[decision];
  if (memory.owners) delete memory.owners[decision];
}

/**
 * `permissions`, опустевший от этой записи, уходит — кроме положенного
 * человеком (пометка или «был пуст до записи»); уходя, оставляет в памяти
 * свою позицию в файле.
 */
function dropPanelPermissions(
  settings: RawSettings,
  wasEmpty: boolean,
  memory: PermissionFilePlaces,
): RawSettings {
  const lists = settings.permissions;
  if (!lists || Object.keys(lists).length > 0 || wasEmpty) return settings;
  if (memory.owners?.permissions === 'human') return settings;
  (memory.at ??= {}).permissions = Object.keys(settings).indexOf('permissions');
  if (memory.owners) delete memory.owners.permissions;
  const rest = { ...settings };
  delete rest.permissions;
  return rest;
}

function isEmptyMemory(memory: PermissionFilePlaces): boolean {
  return (
    Object.keys(memory.owners ?? {}).length === 0 &&
    Object.keys(memory.at ?? {}).length === 0 &&
    Object.keys(memory.patterns ?? {}).length === 0
  );
}
