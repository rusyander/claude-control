import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_HOOK_EVENTS } from '@agentdeck/contracts/vocabulary';
import { homeDir } from '../../platform/os-kind.ts';
import type { LayerMode } from '../adapter.types.ts';
import { anchorClaudeRule } from './repo-deny.ts';

/**
 * Слой человека в Claude Code для режимов `observe` / `off` (03 §Layer control, P87): CLI идёт
 * с `--setting-sources` без user/project/local, а права и окружение человека возвращаются
 * через `--settings` ядра. Хуки человека в `observe` заменяются записью ядра (она отвечает
 * «разрешено»), в `off` не ставятся. `disableAllHooks: true` не используется никогда — он снял
 * бы и хук ядра; `--settings` ядра пишет `false` (F-08). Разрешения (`allow`) и адрес модели из
 * файлов репозитория не переносятся (F-32): их пишет не человек.
 */

export interface HookCommand {
  type: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export type HookTable = Record<string, HookGroup[]>;

export interface UserLayer {
  allow: string[];
  ask: string[];
  deny: string[];
  env: Record<string, string>;
  hooks: HookTable;
  /** Прочитанные файлы и те, что не прочлись (порча — названа, не «пусто»). */
  read: string[];
  unreadable: string[];
}

const HOOK_EVENTS: ReadonlySet<string> = new Set(CLAUDE_HOOK_EVENTS.map((event) => event.name));

/** Переменные, которые выбирают адрес модели или несут учётку. */
const ROUTING_ENV =
  /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH|AWS_BEARER_TOKEN)|_(API_KEY|AUTH_TOKEN)$/;

const CONFIG_DIR_VAR = 'CLAUDE_CONFIG_DIR';
const SETTINGS = 'settings.json';
const LOCAL_SETTINGS = 'settings.local.json';
const PROJECT_DIR = '.claude';

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export function claudeConfigDir(pin: Record<string, string>): string {
  return pin[CONFIG_DIR_VAR] || join(homeDir(pin), PROJECT_DIR);
}

/**
 * Файл слоя и чей он: `user` — настройки самого человека, `project` — файлы репозитория
 * (`.claude/settings*.json` копии), которые пишет кто угодно, имеющий доступ к репозиторию.
 */
export interface LayerFile {
  path: string;
  source: 'user' | 'project';
  /**
   * Откуда CLI считает правило `Tool(/x)` этого файла: корень репозитория у файла проекта, каталог
   * настроек у файла человека. В `--settings` ядра правило пишется абсолютным от него.
   */
  root?: string;
}

/**
 * Файлы настроек в порядке старшинства Claude Code: user < project < local. `repo: false` —
 * копия недоверенная (F-86): файлы репозитория не читаются вовсе, ни хуки, ни `env`, ни права.
 */
export function userLayerFiles(pin: Record<string, string>, cwd: string, repo = true): LayerFile[] {
  // `Tool(/x)` человека CLI читает от каталога его файла (`~/.claude/x`, живая проба
  // `claude.repo-deny`): в `--settings` ядра правило пишется абсолютным от того же каталога.
  const config = claudeConfigDir(pin);
  const user: LayerFile = { path: join(config, SETTINGS), source: 'user', root: config };
  if (!repo) return [user];
  return [
    user,
    { path: join(cwd, PROJECT_DIR, SETTINGS), source: 'project', root: cwd },
    { path: join(cwd, PROJECT_DIR, LOCAL_SETTINGS), source: 'project', root: cwd },
  ];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Поле, которого нет, — пусто; поле не той формы — файл не разобран (не «пусто»). */
const field = (parsed: Record<string, unknown>, name: string): Record<string, unknown> | null => {
  const value = parsed[name];
  if (value === undefined) return {};
  return isRecord(value) ? value : null;
};

export function readUserLayer(files: readonly (string | LayerFile)[]): UserLayer {
  const layer: UserLayer = {
    allow: [],
    ask: [],
    deny: [],
    env: {},
    hooks: {},
    read: [],
    unreadable: [],
  };
  for (const entry of files) {
    const {
      path: file,
      source,
      root,
    } = typeof entry === 'string' ? { path: entry, source: 'user', root: undefined } : entry;
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      layer.unreadable.push(file);
      continue;
    }
    // `null`, массив, строка или поле не той формы — порча (F-34, F-95): `null.permissions`
    // бросал из запуска, а строка `env` давала переменные `0`, `1`, `2`.
    const permissions = isRecord(parsed) ? field(parsed, 'permissions') : null;
    const env = isRecord(parsed) ? field(parsed, 'env') : null;
    const hooks = isRecord(parsed) ? field(parsed, 'hooks') : null;
    if (!permissions || !env || !hooks) {
      layer.unreadable.push(file);
      continue;
    }
    layer.read.push(file);
    // Разрешения репозитория не переносятся (F-32): «да» без вопроса даёт только человек сам.
    if (source === 'user') layer.allow.push(...strings(permissions.allow));
    layer.ask.push(...strings(permissions.ask));
    // `Tool(/x)` — от корня своего файла, а не от каталога `--settings` ядра (F-86).
    const deny = strings(permissions.deny);
    layer.deny.push(...(root ? deny.flatMap((rule) => anchorClaudeRule(rule, [root])) : deny));
    for (const [name, value] of Object.entries(env)) {
      // Адрес модели и учётки из файла репозитория не переносятся: без привязки адреса они
      // увели бы вход человека на адрес репозитория (F-07, F-86).
      if (source === 'project' && ROUTING_ENV.test(name)) continue;
      if (typeof value === 'string') layer.env[name] = value;
    }
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      const list = (layer.hooks[event] ??= []);
      for (const group of groups as unknown[]) {
        if (isRecord(group) && Array.isArray(group.hooks)) list.push(group as unknown as HookGroup);
      }
    }
  }
  return layer;
}

export interface ObservedHook {
  key: string;
  event: string;
  matcher: string | undefined;
  command: string;
}

const quote = (value: string): string => `"${value.replace(/"/g, '\\"')}"`;

/**
 * Хуки человека под режим слоя. `observe`: каждая команда → запись ядра с ключом, исходная
 * команда — в списке наблюдаемых (её текст — данные, не исполняется). `off` — ничего.
 */
export function layerHooks(
  layer: UserLayer,
  mode: LayerMode,
  recorder: { command: string; log: string } | undefined,
): { hooks: HookTable; observed: ObservedHook[] } {
  if (mode !== 'observe' || !recorder) return { hooks: {}, observed: [] };
  const hooks: HookTable = {};
  const observed: ObservedHook[] = [];
  for (const [event, groups] of Object.entries(layer.hooks)) {
    // Имя события идёт в командную строку записи: чужое имя (`x & calc`) — текст оболочки,
    // а не событие CLI (F-33). Такое событие CLI и не вызвал бы — его нет и в записи.
    if (!HOOK_EVENTS.has(event)) continue;
    hooks[event] = groups.map((group, g) => ({
      ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
      hooks: group.hooks.map((hook, h) => {
        const key = `${event}.${g}.${h}`;
        observed.push({ key, event, matcher: group.matcher, command: hook.command ?? '' });
        return {
          type: 'command',
          command: `${recorder.command} --log ${quote(recorder.log)} --hook ${key}`,
        };
      }),
    }));
  }
  return { hooks, observed };
}
