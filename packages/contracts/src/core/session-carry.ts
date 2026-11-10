import { z } from 'zod';

/**
 * Что вызывающий добавляет к сеансу чата сверх настроек F6 (этап 10, G6): прежний исполнитель
 * панели клал это в argv/окружение своего CLI сам — строку о блоке «Тесты», строку профиля, набор
 * панели, флаги наших слоёв. Ядро получает это ТИПИЗИРОВАННЫМИ полями, а не argv: сырые флаги
 * открыли бы обход судьи права (режим прав, пропуск вопросов, свой `--settings`). Каждое поле либо
 * добавляет текст, либо СУЖАЕТ сеанс — расширить права нечем. Поля ложатся в `task.created.session`
 * (журнал); значения переменных — только телом оценки (`env`, F6), в журнал не пишутся.
 *
 * - `append` — дописка к системному промпту после брифа ядра (и без него, `brief: 'none'`): строка
 *   о тестах, строка профиля, блок набора. Бриф несёт каждый переходник — отказа нет.
 * - `plugins` — каталоги плагинов на один сеанс (набор панели, стражи набора). Только переходник с
 *   `sessionCarry.plugins` и только при хуках шага `on` (недоверие к папке, снизившее `on` до
 *   `observe`, плагин не отказывает: набор — каталог панели, не репозитория, G13); плагин со
 *   своими серверами MCP — отказ (строгий список MCP шага собирает ядро).
 * - `settingSources` — CLI грузит НЕ БОЛЬШЕ этих источников настроек («только набор», слой контура
 *   «настройки»); запреты ядра идут его `--settings` и от источников не зависят.
 * - `skills: 'off'` — навыки и команды человека сняты (слой контура «навыки»).
 * - `mcp: 'core'` — серверы MCP человека сняты, остаются серверы ядра (слой контура «MCP»).
 * - `builtinTools` — встроенные инструменты CLI не шире этого списка (слой контура «инструменты»).
 * - `systemPrompt` — свой системный промпт контура ВМЕСТО промпта CLI (s10 G13 p7): прежний
 *   исполнитель клал его `--system-prompt-file`, потому что полный промпт Claude Code топит модель
 *   среднего класса (замер H1). Бриф ядра и `append` идут после него. Только переходник с
 *   `sessionCarry.systemPrompt`; прочим дорога отказывает по имени поля.
 * - `localLayer` — локальный слой проекта вместо источника `project` (s10 G14 p6, см. ниже); только
 *   при `settingSources` без `project` и слое человека `on`.
 * - `hooks` — хуки профиля чата панели (s12: хук списка задач трекера `tools/board-fields-hook.mjs`
 *   — доска заголовками, без описаний). Прежний исполнитель клал их своим `--settings`; ход через
 *   ядро терял их молча (этап 11). Та же форма групп, что `localLayer.hooks`; ядро кладёт их в
 *   свой `--settings` рядом с хуками слоя, хук ядра — последним. Права не расширяет: хук ядра
 *   (судья права) идёт после и решает сам. Как плагины набора — только при хуках шага `on` (или
 *   `observe` от недоверия к папке: команда — каталог панели, не репозитория); только переходник
 *   с `sessionCarry.hooks`, прочим дорога отказывает по имени поля.
 */

export const SETTING_SOURCES = ['user', 'project', 'local'] as const;
export type SettingSource = (typeof SETTING_SOURCES)[number];

/** Правила набора для Codex доходят до ~24 тыс. знаков (`CODEX_KIT_ARG_LIMIT`), плюс строки о тестах. */
export const SESSION_APPEND_MAX = 32_000;
export const SESSION_PLUGINS_MAX = 8;
/** Промпт контура (агент + преамбула, правится человеком) — тот же потолок, что у дописки. */
export const SESSION_SYSTEM_PROMPT_MAX = 32_000;

/**
 * Переменные панели с префиксом `AGENTDECK_`, которые ядро пропускает в `session.env`: их читают
 * хуки набора и блока «Тесты», ядро — нет. Остальные `AGENTDECK_*` ядро держит само (мост, токен).
 */
export const PANEL_SESSION_ENV = [
  'AGENTDECK_KIT_VARIANT',
  'AGENTDECK_TESTS_NOTE',
  'AGENTDECK_TESTS_PROJECT',
] as const;

const absolutePath = z
  .string()
  .min(1)
  .max(1000)
  .regex(/^(?:[A-Za-z]:[\\/]|\\\\|\/)/, 'absolute path');

const builtinTool = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);

const unique = <T>(items: readonly T[]): boolean => new Set(items).size === items.length;

/** Цепочка `CLAUDE.md` с импортами и правила проекта — длиннее дописки набора. */
export const LOCAL_LAYER_INSTRUCTIONS_MAX = 200_000;

const hookEntry = z.looseObject({ type: z.string().min(1).max(32) });
const hookGroup = z.looseObject({
  matcher: z.string().max(1000).optional(),
  hooks: z.array(hookEntry).min(1).max(32),
});
/** Таблица хуков `--settings` Claude Code: событие → группы (слой проекта, профиль чата). */
export const sessionHooksSchema = z.record(
  z.string().regex(/^[A-Za-z]{1,64}$/),
  z.array(hookGroup).max(64),
);
export type SessionHooks = z.infer<typeof sessionHooksSchema>;
const permissionRules = z.array(z.string().min(1).max(2000)).max(1000);

/**
 * Локальный слой проекта (`domains/local-layer` панели, s10 G14 p6): командный слой из копии в
 * `<проект>/.agent/local-layer/build/` ВМЕСТО источника `project` — сжатые инструкции, хуки с
 * заменами из невлитого MR, навыки/агенты/команды плагином. Прежний исполнитель клал его
 * `--setting-sources` без `project`, `--plugin-dir`, `--settings` и дописку; ядро получает его
 * полями и само рисует флаги. Это не расширение: всё здесь — то, что CLI взял бы из командных
 * файлов с источником `project` (права `allow` ядро режет тем же фильтром, что права человека).
 * Значения `env` — из командного `settings.json` в git (локальные значения сборка не копирует),
 * поэтому журнал не держит ничего, чего нет в репозитории.
 *
 * - `plugin` — каталог плагина слоя (`build/plugin`);
 * - `instructions` — `build/instructions.md`, после брифа ядра;
 * - `hooks`, `permissions`, `env` — из `build/settings.json`.
 *
 * Серверов MCP здесь нет: включённые серверы `.mcp.json` ядро и так предлагает сеансу своим
 * чтением (`mcp-source`, строгий список `--mcp-config` ядра), независимо от источников настроек.
 */
export const localLayerCarrySchema = z.strictObject({
  plugin: absolutePath.optional(),
  instructions: z.string().min(1).max(LOCAL_LAYER_INSTRUCTIONS_MAX).optional(),
  hooks: sessionHooksSchema.optional(),
  permissions: z
    .strictObject({
      allow: permissionRules.optional(),
      ask: permissionRules.optional(),
      deny: permissionRules.optional(),
    })
    .optional(),
  env: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(8000))
    .optional(),
});
export type LocalLayerCarry = z.infer<typeof localLayerCarrySchema>;

export const sessionCarryShape = {
  append: z.string().min(1).max(SESSION_APPEND_MAX).optional(),
  plugins: z.array(absolutePath).min(1).max(SESSION_PLUGINS_MAX).refine(unique).optional(),
  settingSources: z.array(z.enum(SETTING_SOURCES)).min(1).max(3).refine(unique).optional(),
  skills: z.enum(['off']).optional(),
  mcp: z.enum(['core']).optional(),
  builtinTools: z.array(builtinTool).min(1).max(64).refine(unique).optional(),
  systemPrompt: z.string().min(1).max(SESSION_SYSTEM_PROMPT_MAX).optional(),
  localLayer: localLayerCarrySchema.optional(),
  hooks: sessionHooksSchema.optional(),
};

export const sessionCarrySchema = z.strictObject(sessionCarryShape);
export type SessionCarry = z.infer<typeof sessionCarrySchema>;

/**
 * Отказ ядра перенести набор панели в сеанс — разбор слов ядра (s10 G13): дорога сеанса
 * (`session-carry-gate.ts`) и переходник Claude (`plugin-carry.ts`) пишут причину в причину шага.
 * Панель (чат) и веб («Чат ядра») называют человеку причину и выход по ней, а не код `failed`.
 * `hooks` — режим хуков шага не `on`; `mcp` — каталог набора объявляет серверы MCP; `missing` —
 * каталога нет, путь не абсолютный или его `plugin.json` не читается.
 *
 * Локальный слой проекта (s10 G14 p7, `local-layer-carry.ts` ядра и `buildCarry` панели):
 * `layerUntrusted` — Claude Code не доверяет папке (F-86), `layerMode` — слой человека сужен
 * сценарием или контуром, `layerSources` — сеанс собран с источником `project` рядом со слоем
 * (ошибка сборки панели), `layerBuild` — каталог плагина слоя не годится, `layerFit` — поле слоя не
 * влезло в сеанс ядра. `unsupported` — переходник CLI не несёт поле переноса (дорога сеанса).
 */
export type KitCarryRefusal =
  | { kind: 'hooks'; mode: string }
  | { kind: 'mcp'; path: string }
  | { kind: 'missing'; path: string }
  | { kind: 'layerUntrusted' }
  | { kind: 'layerMode'; mode: string }
  | { kind: 'layerSources' }
  | { kind: 'layerBuild'; path: string }
  | { kind: 'layerFit'; field: string }
  | { kind: 'unsupported'; adapter: string; fields: string };

const KIT_HOOKS =
  /session-carry-(?:plugins-without-hooks: .*? runs hooks|needs-layer-on: .*? runs it) '(\w+)'/;
const KIT_MCP = /session-carry-plugin: plugin declares MCP servers [^:]*: (.+)$/;
const KIT_MISSING =
  /session-carry-plugin: (?:plugin dir missing|plugin dir is not absolute|plugin manifest unreadable[^:]*): (.+)$/;
const LAYER_OFF =
  /session-carry-local-layer-needs-layer-on: .*? runs the human layer '(\w+)'( \(folder not trusted\))?/;
const LAYER_SOURCES = /session-carry-local-layer-with-project:/;
const LAYER_BUILD =
  /session-carry-local-layer-plugin: (?:plugin dir missing|plugin dir is not absolute|plugin manifest unreadable[^:]*|plugin declares MCP servers [^:]*): (.+)$/;
const LAYER_FIT = /the project local layer does not fit the core session: (\w+)/;
const UNSUPPORTED = /session-carry-unsupported: adapter (\S+) cannot carry (.+?) — /;

function layerRefusalOf(reason: string): KitCarryRefusal | null {
  const off = LAYER_OFF.exec(reason);
  if (off)
    return off[2] ? { kind: 'layerUntrusted' } : { kind: 'layerMode', mode: off[1] as string };
  if (LAYER_SOURCES.test(reason)) return { kind: 'layerSources' };
  const build = LAYER_BUILD.exec(reason);
  if (build) return { kind: 'layerBuild', path: (build[1] as string).trim() };
  const fit = LAYER_FIT.exec(reason);
  if (fit) return { kind: 'layerFit', field: fit[1] as string };
  const unsupported = UNSUPPORTED.exec(reason);
  if (unsupported) {
    return {
      kind: 'unsupported',
      adapter: unsupported[1] as string,
      fields: unsupported[2] as string,
    };
  }
  return null;
}

export function kitCarryRefusalOf(reason: string): KitCarryRefusal | null {
  const layer = layerRefusalOf(reason);
  if (layer) return layer;
  const hooks = KIT_HOOKS.exec(reason);
  if (hooks) return { kind: 'hooks', mode: hooks[1] as string };
  const mcp = KIT_MCP.exec(reason);
  if (mcp) return { kind: 'mcp', path: (mcp[1] as string).trim() };
  const missing = KIT_MISSING.exec(reason);
  if (missing) return { kind: 'missing', path: (missing[1] as string).trim() };
  return null;
}
