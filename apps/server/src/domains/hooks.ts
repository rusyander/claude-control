import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Hook, HookDraft, HookEvent, SettingsSource } from '@claude-control/contracts';
import { readJsonFile, writeJsonFile } from '../lib/safe-io.ts';
import { hookContentId as hookId } from '../lib/hook-id.ts';
import { LOCAL_ID_PREFIX } from '../lib/settings-source.ts';
import type { AppStore } from '../lib/app-store.ts';
import { generateHookScript, hookScriptPath } from './hook-scripts.ts';
import { compiledHookOrigin } from './compiled-markers.ts';
import { readScriptDescription } from '../lib/script-description.ts';

/**
 * Имя файла из формы совпало с существующим скриптом. Маршрут отвечает 409:
 * под таким именем может лежать чужой, давно правленный руками скрипт —
 * пресеты называются как популярные хуки (`session-brief`, `destructive-guard`).
 */
export class HookScriptExistsError extends Error {
  readonly statusCode = 409;
  readonly code = 'script_exists';

  constructor(fileName: string) {
    super(
      `Файл hooks/${fileName} уже есть. Укажите другое имя файла или оставьте поле пустым и задайте команду.`,
    );
    this.name = 'HookScriptExistsError';
  }
}

/** Один ли это файл: Windows не различает регистр и вид слэшей. */
function samePath(a: string, b: string): boolean {
  const normalize = (path: string): string => path.replace(/\\/g, '/');
  return process.platform === 'win32'
    ? normalize(a).toLowerCase() === normalize(b).toLowerCase()
    : normalize(a) === normalize(b);
}

/**
 * Выключенные хуки — обратно на свои места. Снимок помнит позицию среди хуков
 * своего события (`position`); без неё хук встаёт после последнего хука
 * того же события. Позиции применяются по возрастанию, поэтому два
 * выключенных подряд возвращаются в исходном взаимном порядке.
 */
function withRemembered(own: Hook[], remembered: Hook[]): Hook[] {
  const result = [...own];
  const ordered = [...remembered].sort(
    (a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
  );

  for (const hook of ordered) {
    let seen = 0;
    let at = -1;
    let lastSame = -1;
    for (let i = 0; i < result.length; i += 1) {
      if (result[i]!.event !== hook.event) continue;
      if (hook.position !== undefined && seen === hook.position) {
        at = i;
        break;
      }
      seen += 1;
      lastSame = i;
    }
    if (at < 0) at = lastSame >= 0 ? lastSame + 1 : result.length;
    result.splice(at, 0, hook);
  }

  return result;
}

/**
 * В settings.json хуки лежат в три уровня: событие → группы matcher → команды.
 * Для списка и редактирования это неудобно, поэтому разворачиваем структуру
 * в плоский список, а при сохранении собираем обратно ровно в том формате,
 * который понимает Claude Code.
 */

interface RawHookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface RawMatcherGroup {
  matcher?: string;
  hooks: RawHookCommand[];
}

interface RawSettings {
  hooks?: Record<string, RawMatcherGroup[]>;
  [key: string]: unknown;
}

/**
 * Прежний позиционный идентификатор. Нужен ровно для одного: узнать свои
 * старые отметки в состоянии панели после обновления. Без этого выключенные
 * хуки разом «включились» бы, а группы потеряли участников.
 */
function legacyHookId(event: string, groupIndex: number, commandIndex: number): string {
  return `${event}:${groupIndex}:${commandIndex}`;
}

/**
 * Что панель накладывает поверх файла: отметки «выключено» и членство в
 * группах. Для пользовательского `~/.claude` это состояние панели; для чужого
 * `.claude` (проектного) — нейтральный оверлей, иначе отметки владельца машины
 * протекли бы в файлы проекта, к которым они не относятся.
 */
interface HookOverlay {
  isEnabled: (id: string, legacyId: string) => boolean;
  groupIds: (id: string, legacyId: string, command: string) => string[];
}

const NEUTRAL_OVERLAY: HookOverlay = {
  isEnabled: () => true,
  groupIds: () => [],
};

function storeOverlay(store: AppStore): HookOverlay {
  return {
    isEnabled: (id, legacyId) => !store.isDisabled('hook', id, legacyId),
    // Скомпилированный панелью хук участником группы не числится — его
    // принадлежность записана меткой в команде. Без этого триггер сценария шёл
    // без бейджа группы, хотя скомпилированный рядом скилл его носит.
    groupIds: (id, legacyId, command) => {
      const origin = compiledHookOrigin(command);
      if (origin?.kind === 'scenario') return [origin.groupId];
      if (origin?.kind === 'automation') {
        return (
          store.getAutomations().find((item) => item.id === origin.automationId)?.groupIds ?? []
        );
      }
      return store.getGroupIdsFor('hook', id, legacyId);
    },
  };
}

/** Разворачивает один файл настроек в плоский список хуков. */
function parseHooksFile(
  settingsPath: string,
  source: SettingsSource,
  overlay: HookOverlay,
  root?: string,
): Hook[] {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const result: Hook[] = [];
  // Локальные записи помечаются префиксом: два файла могут содержать
  // одинаковый хук, и без префикса правка ушла бы не в тот файл.
  const prefix = source === 'settings-local' ? LOCAL_ID_PREFIX : '';
  const usedIds = new Set<string>();

  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    groups.forEach((group, groupIndex) => {
      group.hooks.forEach((command, commandIndex) => {
        // Полный дубль хука неразличим по содержимому — такому даём суффикс,
        // иначе выключение одного гасило бы оба.
        const base = `${prefix}${hookId(event, group.matcher, command.command)}`;
        let id = base;
        for (let n = 2; usedIds.has(id); n += 1) id = `${base}-${n}`;
        usedIds.add(id);

        const legacyId = `${prefix}${legacyHookId(event, groupIndex, commandIndex)}`;
        const scriptPath = extractScriptPath(command.command);
        // Claude Code запускает хук с cwd = каталог проекта, поэтому относительный
        // путь скрипта в `.claude` проекта — норма. Проверяем его от корня проекта,
        // а не от cwd сервера: иначе живой `.claude/hooks/x.mjs` шёл как «не найден».
        const scriptFile = scriptPath ? resolve(root ?? process.cwd(), scriptPath) : undefined;

        result.push({
          id,
          legacyId,
          event: event as HookEvent,
          matcher: group.matcher,
          command: command.command,
          timeout: command.timeout,
          // Локальный хук выключить нечем: панель в этот файл не пишет,
          // поэтому он всегда показан включённым — как оно и есть на деле.
          isEnabled: source === 'settings-local' || overlay.isEnabled(id, legacyId),
          scriptPath,
          scriptExists: scriptFile ? existsSync(scriptFile) : undefined,
          description: scriptFile ? readScriptDescription(scriptFile) : undefined,
          groupIds: overlay.groupIds(id, legacyId, command.command),
          source,
        });
      });
    });
  }

  return result;
}

function readHooksFrom(settingsPath: string, store: AppStore, source: SettingsSource): Hook[] {
  return parseHooksFile(settingsPath, source, storeOverlay(store));
}

/**
 * Хуки ровно так, как они лежат в файлах, без состояния панели: все включены
 * (выключенного хука в файле не бывает), групп нет, снимки выключенных не
 * подмешиваются. Так читается `.claude` проекта — файлы принадлежат гиту
 * проекта, и отметки владельца машины к ним отношения не имеют.
 */
export function readHooksFromFiles(
  settingsPath: string,
  localPath?: string,
  projectRoot?: string,
): Hook[] {
  const own = parseHooksFile(settingsPath, 'settings', NEUTRAL_OVERLAY, projectRoot);
  const local = localPath
    ? parseHooksFile(localPath, 'settings-local', NEUTRAL_OVERLAY, projectRoot)
    : [];
  return [...own, ...local];
}

/**
 * Все действующие хуки. Claude Code читает `settings.local.json` наравне с
 * основным файлом, поэтому не показать его записи — значит соврать о том, что
 * сейчас срабатывает. Панель их показывает, но не правит.
 */
export function readHooks(settingsPath: string, store: AppStore, localPath?: string): Hook[] {
  const own = readHooksFrom(settingsPath, store, 'settings');
  const local = localPath ? readHooksFrom(localPath, store, 'settings-local') : [];

  // Выключенного хука в файле нет — иначе Claude Code его бы исполнял. Его
  // команда лежит снимком в состоянии панели, и без этой подмешки выключение
  // означало бы потерю: вернуть хук было бы неоткуда.
  const inFile = new Set([...own, ...local].map((hook) => hook.id));
  const remembered = store
    .getDisabledHooks()
    // Снимок мог быть сделан до перехода на контентные id, поэтому его
    // идентификатор пересчитывается по содержимому — иначе тот же самый хук
    // выглядел бы двумя разными записями.
    .map((hook) => ({ ...hook, id: hookId(hook.event, hook.matcher, hook.command) }))
    .filter((hook) => !inFile.has(hook.id))
    // Состояние берём из отметок, а не из снимка: включённый снимок — это
    // хук, которого ждут обратно в файле, и перезапись должна его записать.
    .map((hook) => ({
      ...hook,
      isEnabled: !store.isDisabled('hook', hook.id, hook.legacyId),
    }));

  return [...withRemembered(own, remembered), ...local];
}

/**
 * Собирает плоский список обратно во вложенную структуру settings.json.
 *
 * Ключевое — `source`: список приходит из `readHooks`, где лежат хуки обоих
 * файлов, и каждый должен вернуться в свой. Без разделения локальный хук
 * продублировался бы в основной конфиг при первой же перезаписи.
 */
export function writeHooks(
  settingsPath: string,
  hooks: Hook[],
  backupDir?: string,
  source: SettingsSource = 'settings',
): string | undefined {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const grouped: Record<string, RawMatcherGroup[]> = {};

  // Выключенные хуки в файл не попадают — их команды хранит состояние приложения.
  for (const hook of hooks.filter((item) => item.isEnabled && item.source === source)) {
    const groups = (grouped[hook.event] ??= []);
    // Хуки с одинаковым matcher объединяем в одну группу — так же,
    // как это делает сам Claude Code.
    const existing = groups.find((group) => group.matcher === hook.matcher);
    const command: RawHookCommand = { type: 'command', command: hook.command };
    if (hook.timeout !== undefined) command.timeout = hook.timeout;

    if (existing) existing.hooks.push(command);
    else
      groups.push(
        hook.matcher ? { matcher: hook.matcher, hooks: [command] } : { hooks: [command] },
      );
  }

  settings.hooks = grouped;
  return writeJsonFile(settingsPath, settings, { backupDir });
}

/**
 * Переставить хук вверх/вниз среди хуков того же события. Порядок в файле равен
 * порядку в списке (см. writeHooks), поэтому меняем соседей местами и
 * переписываем. Двигаем только среди включённых хуков того же файла того же
 * события — с выключенными (их в файле нет) и чужими меняться местами незачем.
 */
export function moveHook(
  settingsPath: string,
  store: AppStore,
  id: string,
  direction: 'up' | 'down',
  backupDir?: string,
  localPath?: string,
): string | undefined {
  const hooks = readHooks(settingsPath, store, localPath);
  const index = hooks.findIndex((hook) => hook.id === id);
  if (index < 0) return undefined;

  const current = hooks[index];
  if (!current || !current.isEnabled) return undefined;

  const step = direction === 'up' ? -1 : 1;
  let swapWith = -1;
  for (let i = index + step; i >= 0 && i < hooks.length; i += step) {
    const other = hooks[i];
    if (
      other &&
      other.event === current.event &&
      other.source === current.source &&
      other.isEnabled
    ) {
      swapWith = i;
      break;
    }
  }
  if (swapWith < 0) return undefined; // некуда двигать

  const swapped = hooks[swapWith]!;
  hooks[index] = swapped;
  hooks[swapWith] = current;

  // Перестановка идёт среди хуков одного файла (см. условие поиска соседа),
  // поэтому пишем только файл-источник переставленного хука — как остальные
  // операции (см. targetOf/source в маршрутах). Иначе перестановка глобального
  // хука зря переписывала бы settings.local.json и создавала его пустым.
  if (current.source === 'settings-local') {
    return localPath ? writeHooks(localPath, hooks, backupDir, 'settings-local') : undefined;
  }
  return writeHooks(settingsPath, hooks, backupDir, 'settings');
}

/**
 * Правка хука. `targetPath` указывает, в какой файл писать: правка локальной
 * записи должна вернуться в `settings.local.json`, а не переехать в общий
 * конфиг — иначе она начала бы действовать не только у владельца машины.
 */
export function upsertHook(
  settingsPath: string,
  hooksDir: string,
  hookId: string | null,
  draft: HookDraft,
  store: AppStore,
  backupDir?: string,
  target: { path: string; source: SettingsSource } = { path: settingsPath, source: 'settings' },
): string | undefined {
  const hooks = readHooksFrom(target.path, store, target.source);
  const index = hookId ? hooks.findIndex((hook) => hook.id === hookId) : -1;

  // Если указано имя скрипта, файл создаётся автоматически, а команда
  // собирается из пути к нему: пользователю не нужно ни создавать файл,
  // ни помнить синтаксис запуска. СОЗДАЁТСЯ, а не перезаписывается: под этим
  // именем может лежать чужой скрипт. Исключение — собственный файл правимого
  // хука: его перегенерация и есть цель правки.
  const scriptName = draft.scriptName?.trim();
  if (scriptName) {
    const path = hookScriptPath(hooksDir, scriptName);
    const ownScript = hooks[index]?.scriptPath;
    const isOwn = ownScript !== undefined && samePath(ownScript, path);
    if (existsSync(path) && !isOwn) throw new HookScriptExistsError(basename(path));
  }
  const generated = scriptName ? generateHookScript(hooksDir, draft, backupDir) : undefined;

  const command = generated?.command ?? draft.command;
  // Несколько фильтров объединяются в одно регулярное выражение —
  // именно такой формат понимает Claude Code.
  const matcher = draft.matchers.filter(Boolean).join('|') || undefined;

  const next: Hook = {
    id: hookId ?? `${draft.event}:new:${Date.now()}`,
    event: draft.event,
    matcher,
    command,
    timeout: draft.timeout,
    isEnabled: draft.isEnabled,
    scriptPath: generated?.path ?? extractScriptPath(command),
    groupIds: draft.groupIds,
    source: target.source,
  };

  if (index >= 0) hooks[index] = next;
  else hooks.push(next);

  return writeHooks(target.path, hooks, backupDir, target.source);
}

export function deleteHook(
  settingsPath: string,
  hookId: string,
  store: AppStore,
  backupDir?: string,
  target: { path: string; source: SettingsSource } = { path: settingsPath, source: 'settings' },
): string | undefined {
  const hooks = readHooksFrom(target.path, store, target.source).filter(
    (hook) => hook.id !== hookId,
  );
  // Хук мог быть выключен — тогда его команда лежит снимком. Удаление должно
  // забирать и её, иначе выключенный хук вернулся бы из небытия.
  store.pruneDisabledHooks([hookId]);
  return writeHooks(target.path, hooks, backupDir, target.source);
}

/**
 * Достаёт путь к скрипту из команды вида `node "C:/.../hook.mjs"`.
 * Нужен, чтобы показать, существует ли файл, и дать открыть его на редактирование.
 */
function extractScriptPath(command: string): string | undefined {
  const quoted = /["']([^"']+\.(?:mjs|cjs|js|ts|mts|cts|sh|ps1|py))["']/.exec(command);
  if (quoted?.[1]) return quoted[1];

  const bare = /(?:^|\s)((?:[A-Za-z]:)?[^\s"']+\.(?:mjs|cjs|js|ts|mts|cts|sh|ps1|py))/.exec(
    command,
  );
  return bare?.[1];
}
