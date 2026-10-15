import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPanelJson, writePanelJson } from '../../../lib/app-store/group-sources.ts';
import { normalizeProjectPath } from '../../../lib/app-store/projects.ts';
import { excludeFileOf } from '../../groups/override/override.ts';

/**
 * Хуки блока «Тесты» в проекте (решение владельца 15.10): строка о блоке в начале
 * сессии и проверка конца хода (`tools/tests-hook.mjs`) — для ЛЮБОГО Claude Code
 * над проектом: чата панели, VS Code, терминала. Носитель —
 * `<проект>/.claude/settings.local.json`: CLI читает его сам, в git он не уходит
 * (у Claude Code он личный; панель ещё и пишет строку в `.git/info/exclude`, если
 * гит его не игнорирует).
 *
 * Свои записи узнаются по имени скрипта в команде — путь к панели меняется с
 * переездом, и старая запись заменяется, а не копится. Чужие хуки файла не
 * трогаются. Выключение возвращает файл байт в байт, если его не правили после
 * панели, иначе снимает только свои записи.
 */

export const TURN_HOOK_SCRIPT = 'tests-hook.mjs';
const SETTINGS_LOCAL = '.claude/settings.local.json';
const STORE = 'tests-turn-hooks.json';
const EXCLUDE_MARKER = '# agentdeck tests hooks';
const EXCLUDE_LINE = `/${SETTINGS_LOCAL}`;
const EVENTS = { SessionStart: 'session', Stop: 'stop' } as const;

export type TurnHooksState = 'on' | 'off' | 'broken';

interface Record_ {
  state: 'on' | 'off';
  /** Байты файла до панели: `null` — файла не было. */
  original?: string | null;
  written?: string;
  /** Блок, дописанный в исключения гита. */
  exclude?: string;
}
interface Store {
  projects: Record<string, Record_>;
}

type HookEntry = {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
};
type Settings = { hooks?: Record<string, HookEntry[] | undefined> } & Record<string, unknown>;

const readStore = (appData: string): Store => {
  const store = readPanelJson<Store>(appData, STORE, { projects: {} });
  return store && typeof store.projects === 'object' ? store : { projects: {} };
};

function readBytes(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'latin1') : null;
}

function isOurs(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((hook) => hook.command?.includes(TURN_HOOK_SCRIPT));
}

function parse(file: string): Settings | undefined {
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Settings)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Скрипт хука панели — абсолютным путём: проект зовёт его из своего каталога. */
export function testsHookScript(): string {
  return fileURLToPath(new URL('../../../../../../tools/tests-hook.mjs', import.meta.url));
}

/** Команда хука: `node "<abs>/tools/tests-hook.mjs" <event>`. */
export function turnHookCommand(script: string, event: string): string {
  return `node "${script}" ${event}`;
}

/** Настройки с нашими записями ровно один раз и с нынешним путём скрипта. */
export function withTurnHooks(settings: Settings, script: string): Settings {
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [name, event] of Object.entries(EVENTS)) {
    const foreign = (hooks[name] ?? []).filter((entry) => !isOurs(entry));
    hooks[name] = [
      ...foreign,
      {
        hooks: [{ type: 'command', command: turnHookCommand(script, event), timeout: 45 }],
      },
    ];
  }
  return { ...settings, hooks };
}

export function withoutTurnHooks(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookEntry[] | undefined> = {};
  for (const [name, entries] of Object.entries(settings.hooks)) {
    const left = (entries ?? []).filter((entry) => !isOurs(entry));
    if (left.length > 0) hooks[name] = left;
  }
  const { hooks: _drop, ...rest } = settings;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

/** Файл уже игнорируется гитом (правилом человека или самим CLI) — дописывать нечего. */
function ignored(root: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', SETTINGS_LOCAL], {
      cwd: root,
      stdio: 'ignore',
      timeout: 5000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function hideFromGit(root: string): string | undefined {
  const file = excludeFileOf(root);
  if (!file || ignored(root)) return undefined;
  const block = `${EXCLUDE_MARKER}\n${EXCLUDE_LINE}\n`;
  const now = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (now.includes(block)) return block;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${now}${now && !now.endsWith('\n') ? '\n' : ''}${block}`, 'utf8');
  return block;
}

function unhide(root: string, block: string | undefined): void {
  const file = block ? excludeFileOf(root) : undefined;
  if (!file || !block || !existsSync(file)) return;
  const now = readFileSync(file, 'utf8');
  if (now.includes(block)) writeFileSync(file, now.replace(block, ''), 'utf8');
}

export function readTurnHooks(appData: string, root: string): TurnHooksState {
  const record = readStore(appData).projects[normalizeProjectPath(root)];
  if (record?.state === 'off') return 'off';
  const settings = parse(join(root, SETTINGS_LOCAL));
  if (!settings) return 'broken';
  return Object.values(settings.hooks ?? {}).some((entries) => (entries ?? []).some(isOurs))
    ? 'on'
    : 'off';
}

/**
 * Поставить хуки. Выключенный человеком проект не трогается, пока `force` не
 * пришёл от него же (переключатель раздела). Битый личный файл не переписывается.
 */
export function installTurnHooks(
  appData: string,
  root: string,
  script: string,
  force = false,
): TurnHooksState {
  const key = normalizeProjectPath(root);
  const store = readStore(appData);
  const record = store.projects[key];
  if (record?.state === 'off' && !force) return 'off';
  const file = join(root, SETTINGS_LOCAL);
  const settings = parse(file);
  if (!settings) return 'broken';
  const next = `${JSON.stringify(withTurnHooks(settings, script), null, 2)}\n`;
  const before = readBytes(file);
  if (before === next) {
    if (record?.state !== 'on') {
      store.projects[key] = { ...record, state: 'on' };
      writePanelJson(appData, STORE, store);
    }
    return 'on';
  }
  // Прежние байты — от ПЕРВОЙ записи панели: обновление пути их не перетирает.
  // Запоминаются ДО записи в проект: не записалось состояние панели — проект не
  // тронут, иначе выключение не знало бы, что возвращать.
  const original = record && 'original' in record ? (record.original ?? null) : before;
  store.projects[key] = { ...record, state: 'on', original, written: next };
  writePanelJson(appData, STORE, store);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next, 'utf8');
  const exclude = record?.exclude ?? hideFromGit(root);
  store.projects[key] = {
    state: 'on',
    original,
    written: readBytes(file) ?? next,
    ...(exclude ? { exclude } : {}),
  };
  writePanelJson(appData, STORE, store);
  return 'on';
}

/** Снять хуки по слову человека: проект запоминается выключенным. */
export function removeTurnHooks(appData: string, root: string): TurnHooksState {
  const key = normalizeProjectPath(root);
  const store = readStore(appData);
  const record = store.projects[key];
  const file = join(root, SETTINGS_LOCAL);
  const now = readBytes(file);
  if (record?.written !== undefined && now === record.written) {
    if (record.original === null || record.original === undefined) rmSync(file, { force: true });
    else writeFileSync(file, record.original, 'latin1');
  } else if (now !== null) {
    const settings = parse(file);
    if (!settings) return 'broken';
    writeFileSync(file, `${JSON.stringify(withoutTurnHooks(settings), null, 2)}\n`, 'utf8');
  }
  unhide(root, record?.exclude);
  store.projects[key] = { state: 'off' };
  writePanelJson(appData, STORE, store);
  return 'off';
}

/**
 * Все проекты реестра — с хуками (старт панели, добавление проекта). Каталога нет
 * или файл битый — проект пропускается, остальные ставятся.
 */
export function reconcileTurnHooks(
  appData: string,
  roots: readonly string[],
  script: string,
  log?: (message: string, error: unknown) => void,
): void {
  for (const root of roots) {
    try {
      if (existsSync(root)) installTurnHooks(appData, root, script);
    } catch (error) {
      log?.(`tests turn hooks: ${root}`, error);
    }
  }
}
