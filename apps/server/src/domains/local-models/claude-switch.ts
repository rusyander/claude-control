import type { LocalClaudeInfo } from '@agentdeck/contracts/local-models';
import { readJsonFile, writeJsonFile } from '../../lib/safe-io.ts';
import { localError } from './errors.ts';
import type { ClaudeModelPicker, ClaudeSwitchRecord } from './paths.ts';

/**
 * «Claude Code на локальной модели» — одна галочка, которая уводит САМ Claude
 * Code на сервер моделей: терминал, расширение редактора и чаты панели.
 *
 * Пишется блок `env` пользовательского settings.json — его Claude Code читает при
 * каждом старте, и он ПЕРЕКРЫВАЕТ окружение процесса (замер 07.10 на claude
 * 2.1.286: при адресе и в окружении, и в settings.json запрос ушёл по файлу).
 * Поэтому новый сеанс — новое окно терминала, новый чат в редакторе — подхватывает
 * включение сразу, без правки руками и без перезапуска панели.
 *
 * Ollama говорит на Anthropic Messages сам, поэтому адрес — сервер моделей без
 * пути: `/v1/messages` Claude Code допишет. Алиасы моделей (`opus`, `sonnet`,
 * `haiku`, `fable`) и модель подагентов уводятся на ту же модель: в settings.json
 * у человека обычно стоит алиас, и без них он ушёл бы на имя, которого у
 * Ollama нет. Окно контекста — настоящее окно сервера: без него Claude Code
 * считает незнакомой модели 200k (так и пишет), сжатие истории не наступает
 * вовремя, и Ollama молча обрезает начало запроса — вместе с системным промптом.
 *
 * Выбор модели (`/model` в терминале, список моделей в расширении редактора)
 * перестраивается ключом `modelPicker`: одна строка с именем локальной модели
 * вместо Opus/Sonnet/Haiku. Иначе выбор показывал бы «Opus», а отвечал бы Qwen, —
 * ровно та путаница, о которой человек узнаёт последним.
 *
 * Выключение возвращает ровно то, что стояло до включения (`previous`); переменную,
 * которую человек сменил руками после включения, оно не трогает.
 */

/** Ключ-заглушка: Ollama ключ не проверяет, а Claude Code без ключа не стартует. */
export const CLAUDE_SWITCH_TOKEN = 'ollama';

/** Имя настройки в отказе контура: им человек находит, что увело прогон. */
export const CLAUDE_SWITCH_SETTING = 'settings.json → env.ANTHROPIC_BASE_URL';

/** Ключ settings.json, которым включение перестраивает выбор модели. */
export const CLAUDE_SWITCH_PICKER_KEY = 'modelPicker';

/**
 * Выбор модели — одна строка: локальная модель под своим именем. Встроенные
 * строки скрыты (`replaceBuiltInOptions`): выбранный «Opus» всё равно ушёл бы на
 * ту же модель, а подпись соврала бы.
 */
export function claudeSwitchPicker(input: {
  model: string;
  title: string;
  baseUrl: string;
}): ClaudeModelPicker {
  return {
    options: [
      {
        model: input.model,
        label: input.title,
        description: `${input.model} · ${new URL(input.baseUrl).host}`,
      },
    ],
    replaceBuiltInOptions: true,
  };
}

/** Все переменные, которые ставит включение, — в порядке записи. */
export const CLAUDE_SWITCH_VARS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  // Пусто — чтобы настоящий ключ из окружения человека не ушёл заголовком на
  // локальный сервер (так советует и документация Ollama для Claude Code).
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
] as const;

export function claudeSwitchEnv(input: {
  baseUrl: string;
  model: string;
  context: number;
}): Record<string, string> {
  const { model } = input;
  return {
    ANTHROPIC_BASE_URL: input.baseUrl.replace(/\/$/, ''),
    ANTHROPIC_AUTH_TOKEN: CLAUDE_SWITCH_TOKEN,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(input.context),
  };
}

interface ClaudeSettingsFile {
  env?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Испорченный settings.json — отказ, а не пустой объект: записать поверх него
 * значило бы стереть все настройки человека ради одной галочки.
 */
function readSettings(settingsPath: string): ClaudeSettingsFile {
  let settings: unknown;
  try {
    settings = readJsonFile<unknown>(settingsPath, {});
  } catch {
    throw localError(
      'local-claude-settings-broken',
      `settings.json Claude не читается как JSON — исправьте файл: ${settingsPath}`,
      { path: settingsPath },
    );
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw localError(
      'local-claude-settings-broken',
      `settings.json Claude не читается как JSON — исправьте файл: ${settingsPath}`,
      { path: settingsPath },
    );
  }
  return settings as ClaudeSettingsFile;
}

function envOf(settings: ClaudeSettingsFile): Record<string, unknown> {
  return settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
    ? settings.env
    : {};
}

/**
 * Включить (или пересобрать на другую модель). Уже включённое хранит прежнее
 * `previous`: иначе повторное включение запомнило бы «до» собственную запись, и
 * выключение вернуло бы Qwen вместо Claude.
 */
export function switchClaudeOn(input: {
  settingsPath: string;
  model: string;
  vars: Record<string, string>;
  picker?: ClaudeModelPicker;
  current: ClaudeSwitchRecord | undefined;
  backupDir?: string;
}): ClaudeSwitchRecord {
  const settings = readSettings(input.settingsPath);
  const env = { ...envOf(settings) };
  const same = input.current?.settingsPath === input.settingsPath ? input.current : undefined;
  const previous: Record<string, string | null> = {};
  for (const key of Object.keys(input.vars)) {
    if (same && key in same.previous) {
      previous[key] = same.previous[key] ?? null;
      continue;
    }
    const value = env[key];
    previous[key] = typeof value === 'string' ? value : null;
  }
  Object.assign(env, input.vars);
  settings.env = env;
  let picker: ClaudeSwitchRecord['picker'];
  if (input.picker) {
    const before = same?.picker
      ? same.picker.previous
      : (settings[CLAUDE_SWITCH_PICKER_KEY] ?? null);
    settings[CLAUDE_SWITCH_PICKER_KEY] = input.picker;
    picker = { written: input.picker, previous: before };
  }
  writeJsonFile(input.settingsPath, settings, { backupDir: input.backupDir });
  return {
    model: input.model,
    settingsPath: input.settingsPath,
    written: { ...input.vars },
    previous,
    ...(picker ? { picker } : {}),
  };
}

/**
 * Выключить: вернуть прежние значения тех переменных, что всё ещё стоят так, как
 * их записало включение. Остальные — правка человека, их не трогаем.
 */
export function switchClaudeOff(
  record: ClaudeSwitchRecord,
  backupDir?: string,
): { restored: string[]; kept: string[] } {
  const settings = readSettings(record.settingsPath);
  const env = { ...envOf(settings) };
  const restored: string[] = [];
  const kept: string[] = [];
  for (const [key, written] of Object.entries(record.written)) {
    if (env[key] !== written) {
      if (key in env) kept.push(key);
      continue;
    }
    const before = record.previous[key];
    if (before === null || before === undefined) delete env[key];
    else env[key] = before;
    restored.push(key);
  }
  if (Object.keys(env).length > 0) settings.env = env;
  else delete settings.env;
  if (record.picker) {
    if (samePicker(settings[CLAUDE_SWITCH_PICKER_KEY], record.picker.written)) {
      const before = record.picker.previous;
      if (before === null || before === undefined) delete settings[CLAUDE_SWITCH_PICKER_KEY];
      else settings[CLAUDE_SWITCH_PICKER_KEY] = before;
      restored.push(CLAUDE_SWITCH_PICKER_KEY);
    } else if (CLAUDE_SWITCH_PICKER_KEY in settings) kept.push(CLAUDE_SWITCH_PICKER_KEY);
  }
  writeJsonFile(record.settingsPath, settings, { backupDir });
  return { restored, kept };
}

function samePicker(value: unknown, written: ClaudeModelPicker): boolean {
  return JSON.stringify(value) === JSON.stringify(written);
}

/** Состояние для экрана: включено ли, куда и что поменяли руками после включения. */
export function describeClaudeSwitch(
  record: ClaudeSwitchRecord | undefined,
  settingsPath: string,
): LocalClaudeInfo {
  const vars = [...CLAUDE_SWITCH_VARS];
  if (!record) return { on: false, model: '', settingsPath, vars, drift: [] };
  let env: Record<string, unknown> = {};
  let pickerNow: unknown;
  try {
    const settings = readSettings(record.settingsPath);
    env = envOf(settings);
    pickerNow = settings[CLAUDE_SWITCH_PICKER_KEY];
  } catch {
    // Файл испорчен после включения: экран всё равно должен показать, что
    // галочка стоит, — выключение само скажет, почему не может записать.
  }
  const drift = Object.entries(record.written)
    .filter(([key, value]) => env[key] !== value)
    .map(([key]) => key);
  if (record.picker && !samePicker(pickerNow, record.picker.written))
    drift.push(CLAUDE_SWITCH_PICKER_KEY);
  return { on: true, model: record.model, settingsPath: record.settingsPath, vars, drift };
}
