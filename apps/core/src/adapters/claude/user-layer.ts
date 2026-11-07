import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_HOOK_EVENTS } from '@agentdeck/contracts/vocabulary';
import { currentOs, homeDir, type OsKind } from '../../platform/os-kind.ts';
import { pathFlavour } from '../../platform/paths.ts';
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
  /** Файл каждой группы хуков: `hookFiles[event][i]` — откуда `hooks[event][i]` (ключ описи). */
  hookFiles: Record<string, string[]>;
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

/** `os` — для расчёта путей чужой ОС (исключения личной памяти, их тесты на любой машине). */
export function claudeConfigDir(pin: Record<string, string>, os: OsKind = currentOs()): string {
  return pin[CONFIG_DIR_VAR] || pathFlavour(os).join(homeDir(pin, os), PROJECT_DIR);
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
    hookFiles: {},
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
      const from = (layer.hookFiles[event] ??= []);
      for (const group of groups as unknown[]) {
        if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
        list.push(group as unknown as HookGroup);
        from.push(file);
      }
    }
  }
  return layer;
}

export interface ObservedHook {
  key: string;
  event: string;
  matcher: string | undefined;
  /** `command` — исполнима записью; другой вид (`prompt`, `agent`) запись назовёт сбоем. */
  type: string;
  command: string;
  /** Срок хука в секундах, как у CLI; нет — срок CLI по умолчанию. */
  timeout?: number;
  sourcePath: string;
}

const quote = (value: string): string => `"${value.replace(/"/g, '\\"')}"`;

/** Срок хука без `timeout` у записи (сек); CLI сам ждёт не меньше. */
export const HOOK_TIMEOUT_S = 60;

/**
 * Хуки человека в порядке старшинства с ключами описи (`<событие>.<группа>.<хук>`): тот же ключ
 * у описи, у записи `observe` и у отказа хука в потоке. Чужое имя события (`x & calc`) — не
 * событие CLI: в записи его нет (F-33), CLI его и не вызвал бы.
 */
export function keyedHooks(layer: Pick<UserLayer, 'hooks' | 'hookFiles'>): ObservedHook[] {
  const out: ObservedHook[] = [];
  for (const [event, groups] of Object.entries(layer.hooks)) {
    if (!HOOK_EVENTS.has(event)) continue;
    groups.forEach((group, g) =>
      group.hooks.forEach((hook, h) =>
        out.push({
          key: `${event}.${g}.${h}`,
          event,
          matcher: typeof group.matcher === 'string' ? group.matcher : undefined,
          type: typeof hook.type === 'string' ? hook.type : 'command',
          command: typeof hook.command === 'string' ? hook.command : '',
          ...(typeof hook.timeout === 'number' ? { timeout: hook.timeout } : {}),
          sourcePath: layer.hookFiles[event]?.[g] ?? '',
        }),
      ),
    );
  }
  return out;
}

/**
 * Хуки человека под режим слоя. `observe`: каждый хук → запись ядра с ключом, исходная
 * команда — в списке наблюдаемых (её текст — данные, не argv записи). `off` — ничего. Без
 * записи `observe` хуков не ставит — и это названо (`unrecorded`), не молчаливый `off`.
 */
export function layerHooks(
  layer: UserLayer,
  mode: LayerMode,
  recorder: { command: string; log: string } | undefined,
  observedFile: string,
): { hooks: HookTable; observed: ObservedHook[]; unrecorded: boolean } {
  const keyed = mode === 'observe' ? keyedHooks(layer) : [];
  if (!recorder) return { hooks: {}, observed: [], unrecorded: keyed.length > 0 };
  const hooks: HookTable = {};
  for (const hook of keyed) {
    const [, g] = hook.key.split('.');
    const groups = (hooks[hook.event] ??= []);
    const index = Number(g);
    groups[index] ??= {
      ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
      hooks: [],
    };
    groups[index].hooks.push({
      type: 'command',
      command: `${recorder.command} --log ${quote(recorder.log)} --hook ${hook.key} --observed ${quote(observedFile)}`,
      // Запись ждёт хук человека его же сроком: CLI не должен оборвать её раньше.
      timeout: (hook.timeout ?? HOOK_TIMEOUT_S) + 5,
    });
  }
  for (const event of Object.keys(hooks)) hooks[event] = hooks[event]!.filter(Boolean);
  return { hooks, observed: keyed, unrecorded: false };
}
