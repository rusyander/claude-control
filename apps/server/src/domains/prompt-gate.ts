import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Hook, PromptGateInfo, PromptGateSettings } from '@agentdeck/contracts';
import type { AppStore } from '../lib/app-store.ts';
import { writeTextFile } from '../lib/safe-io.ts';
import { readHooks, writeHooks } from './hooks.ts';
import { readRules } from './dlp/rules-store.ts';
import { buildGateScript, type GateScriptConfig } from './prompt-gate/script.ts';
import { BRAND_NAME, BRAND_SLUG, LEGACY_BRAND_NAME, LEGACY_BRAND_SLUG } from '../lib/brand.mjs';

/**
 * Гейт на промпте: установка и снятие хука `UserPromptSubmit`.
 *
 * Панель здесь делает ровно то, что человек сделал бы руками: кладёт скрипт в
 * каталог хуков и прописывает его в `settings.json` — через тот же домен хуков,
 * что и обычная правка, поэтому в разделе «Хуки» он виден как обычный хук, его
 * можно выключить, посмотреть и удалить оттуда. Отдельного скрытого механизма
 * нет намеренно: скрытый хук в чужом конфиге — худшее, что может сделать панель.
 *
 * Правила общие с прокси (`dlp-rules.json`), второго словаря нет.
 */

const SCRIPT_NAME = `${BRAND_SLUG}-prompt-gate.mjs`;
/**
 * Имя скрипта до переименования продукта (17.09.2026). Такой хук уже стоит у
 * людей и остаётся СВОИМ: его видно установленным, а применение настроек
 * переносит его под новое имя, а не ставит рядом второй гейт.
 */
const LEGACY_SCRIPT_NAME = `${LEGACY_BRAND_SLUG}-prompt-gate.mjs`;
const RULES_FILE = 'dlp-rules.json';
const JOURNAL_FILE = 'dlp-journal.jsonl';
const STATE_FILE = 'state.json';

export interface GateLocation {
  hooksDir: string;
  settingsPath: string;
  appDataDir: string;
}

export function gateScriptPath(hooksDir: string): string {
  return join(hooksDir, SCRIPT_NAME);
}

/** Команда запуска — тот же вид, что у скриптов, создаваемых разделом хуков. */
export function gateCommand(hooksDir: string): string {
  return `node "${gateScriptPath(hooksDir).replace(/\\/g, '/')}"`;
}

function legacyGateScriptPath(hooksDir: string): string {
  return join(hooksDir, LEGACY_SCRIPT_NAME);
}

function isGateHook(hook: Hook): boolean {
  return (
    hook.event === 'UserPromptSubmit' &&
    (hook.command.includes(SCRIPT_NAME) || hook.command.includes(LEGACY_SCRIPT_NAME))
  );
}

function isLegacyGateHook(hook: Hook): boolean {
  return hook.event === 'UserPromptSubmit' && hook.command.includes(LEGACY_SCRIPT_NAME);
}

/**
 * Скрипт, который панель положила бы при этих настройках. Флаг журнала в него
 * не зашит: хук читает его из `state.json` в момент срабатывания, поэтому
 * тумблер «Вести журнал» не оставляет на диске устаревший скрипт.
 */
function expectedScript(location: GateLocation, settings: PromptGateSettings): string {
  return buildGateScript({
    rulesPath: join(location.appDataDir, RULES_FILE),
    journalPath: join(location.appDataDir, JOURNAL_FILE),
    statePath: join(location.appDataDir, STATE_FILE),
    action: settings.action,
  });
}

/**
 * Свой ли это скрипт — независимо от настроек, с которыми его генерировали.
 * Конфигурация вписана в файл одним JSON-блоком: разбираем её и собираем скрипт
 * заново; совпал байт в байт — значит, файл панели (пусть и со старым
 * действием), и его можно переписать. Иначе файл правили руками.
 *
 * Раньше сравнивали с ожидаемым для ТЕКУЩИХ настроек, и смена действия в
 * панели читалась как чужая правка: скрипт не перезаписывался и продолжал
 * блокировать при выбранном «предупредить».
 */
export function isPanelScript(source: string): boolean {
  return panelScriptState(source) !== 'foreign';
}

/**
 * Ядра, которые панель уже раскладывала по машинам (sha256 обрезанного текста).
 * Скрипт с таким ядром — свой, просто собранный прошлой версией: без этого
 * списка каждое изменение образцов объявляло бы установленный хук чужой правкой,
 * и он навсегда остался бы со старым набором (15.09.2026, образцы Р11).
 */
const PAST_CORES = new Set(['d3f9e8a3b45bd7b34859a0e3ffd915307148409b7c3c9d0ff47d7e065bf3eb2e']);

const CORE_END = '\n\n/** Ведём ли журнал';

type ScriptState = 'current' | 'outdated' | 'foreign';

function panelScriptState(source: string): ScriptState {
  const direct = scriptStateAsIs(source);
  if (direct !== 'foreign') return direct;
  // Скрипт, собранный до переименования продукта: прежнее имя вписано в шапку и
  // в предупреждения. С новым именем он совпал — значит свой, просто устарел.
  const renamed = source.split(LEGACY_BRAND_NAME).join(BRAND_NAME);
  if (renamed === source) return 'foreign';
  return scriptStateAsIs(renamed) === 'foreign' ? 'foreign' : 'outdated';
}

/** Откуда скрипт читает правила — из его же блока настроек. */
function scriptRulesPath(source: string): string | undefined {
  const match = /^const CONFIG = (\{[\s\S]*?\n\});$/m.exec(source);
  if (!match?.[1]) return undefined;
  try {
    return (JSON.parse(match[1]) as GateScriptConfig).rulesPath;
  } catch {
    return undefined;
  }
}

function scriptStateAsIs(source: string): ScriptState {
  const match = /^const CONFIG = (\{[\s\S]*?\n\});$/m.exec(source);
  if (!match?.[1]) return 'foreign';
  let expected: string;
  try {
    expected = buildGateScript(JSON.parse(match[1]) as GateScriptConfig);
  } catch {
    return 'foreign';
  }
  if (expected === source) return 'current';

  // Ядро — между блоком настроек и первой функцией шаблона. Всё вокруг обязано
  // совпасть байт в байт: правка руками где угодно ещё остаётся чужой.
  const coreStart = match.index + match[0].length;
  const coreEnd = source.indexOf(CORE_END, coreStart);
  const expectedEnd = expected.indexOf(CORE_END, coreStart);
  if (coreEnd < 0 || expectedEnd < 0) return 'foreign';
  const core = source.slice(coreStart, coreEnd).trim();
  if (!PAST_CORES.has(createHash('sha256').update(core).digest('hex'))) return 'foreign';
  const rebuilt =
    source.slice(0, coreStart) + expected.slice(coreStart, expectedEnd) + source.slice(coreEnd);
  return rebuilt === expected ? 'outdated' : 'foreign';
}

export function describePromptGate(store: AppStore, location: GateLocation): PromptGateInfo {
  const settings = store.getSettings().promptGate;
  const freshPath = gateScriptPath(location.hooksDir);
  const legacyPath = legacyGateScriptPath(location.hooksDir);
  const scriptPath = !existsSync(freshPath) && existsSync(legacyPath) ? legacyPath : freshPath;

  const registered = readHooks(location.settingsPath, store).some(
    (hook) => isGateHook(hook) && hook.isEnabled,
  );
  const exists = existsSync(scriptPath);

  let customized = false;
  let outdated = false;
  if (exists) {
    const current = safeRead(scriptPath);
    const state = current === undefined ? 'foreign' : panelScriptState(current);
    customized = state === 'foreign';
    // Свой скрипт устарел и тогда, когда лежит под прежним именем или читает
    // правила из прежнего каталога данных: после переезда тот больше не
    // обновляется, и гейт молча работал бы по застывшему списку.
    outdated =
      state === 'outdated' ||
      (state === 'current' &&
        (scriptPath === legacyPath ||
          scriptRulesPath(current ?? '') !== join(location.appDataDir, RULES_FILE)));
  }

  let rulesCount = 0;
  let blockRulesCount = 0;
  let problem: string | undefined;
  try {
    const rules = readRules(location.appDataDir).filter((rule) => rule.enabled);
    rulesCount = rules.length;
    blockRulesCount = rules.filter((rule) => rule.action === 'block').length;
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }

  if (!problem && registered && !exists) problem = 'скрипт хука не найден на диске';

  return {
    settings,
    installed: registered && exists,
    scriptPath,
    command: gateCommand(location.hooksDir),
    customized,
    outdated,
    rulesCount,
    blockRulesCount,
    problem,
  };
}

/**
 * Привести диск в соответствие с настройками: включено — скрипт на месте и
 * зарегистрирован, выключено — ни того, ни другого.
 *
 * Скрипт, который человек правил руками, НЕ перезаписывается: об этом сообщает
 * `customized`, а перезапись — отдельное явное действие. Панель, молча
 * затирающая чужую правку в чужом конфиге, теряет доверие один раз и навсегда.
 * Свой же скрипт (хоть и собранный при других настройках) переписывается
 * свободно — иначе смена действия не доходила бы до диска.
 */
export function applyPromptGate(
  store: AppStore,
  location: GateLocation,
  settings: PromptGateSettings,
  options: { force?: boolean; backupDir?: string } = {},
): PromptGateInfo {
  const scriptPath = gateScriptPath(location.hooksDir);
  const current = existsSync(scriptPath) ? safeRead(scriptPath) : undefined;
  const ours = current !== undefined && isPanelScript(current);
  const legacyPath = legacyGateScriptPath(location.hooksDir);
  const legacy = existsSync(legacyPath) ? safeRead(legacyPath) : undefined;
  const legacyOurs = legacy !== undefined && isPanelScript(legacy);

  // Правленный руками скрипт под прежним именем без явной перезаписи не
  // трогаем вовсе: второй гейт рядом с ним проверял бы промпт дважды.
  if (legacy !== undefined && !legacyOurs && !options.force && current === undefined) {
    return describePromptGate(store, location);
  }

  if (settings.enabled) {
    const wanted = expectedScript(location, settings);
    if ((current === undefined || options.force || ours) && current !== wanted) {
      writeTextFile(scriptPath, wanted, { backupDir: options.backupDir });
    }
    registerHook(store, location, true, options.backupDir);
    if (legacyOurs) rmSync(legacyPath, { force: true });
  } else {
    registerHook(store, location, false, options.backupDir);
    // Свою правку не выбрасываем: снятие регистрации уже выключило хук, а файл
    // человек может забрать себе.
    if (ours) rmSync(scriptPath, { force: true });
    if (legacyOurs) rmSync(legacyPath, { force: true });
  }

  return describePromptGate(store, location);
}

function registerHook(
  store: AppStore,
  location: GateLocation,
  present: boolean,
  backupDir?: string,
): void {
  const all = readHooks(location.settingsPath, store);
  const hooks = all.filter((hook) => !isGateHook(hook));
  const registered = all.some((hook) => isGateHook(hook) && hook.isEnabled);
  const legacyRegistered = all.some(isLegacyGateHook);

  // Нечего менять — не трогаем settings.json: смена действия при выключенном
  // гейте иначе переписывала бы чужой конфиг (и плодила резервные копии) зря.
  if (registered === present && !legacyRegistered) return;

  if (present) {
    hooks.push({
      id: `UserPromptSubmit:prompt-gate`,
      event: 'UserPromptSubmit',
      command: gateCommand(location.hooksDir),
      isEnabled: true,
      scriptPath: gateScriptPath(location.hooksDir),
      groupIds: [],
      source: 'settings',
      // Секунд достаточно с запасом: чтение файла правил и поиск по тексту
      // промпта — единственное, что скрипт делает.
      timeout: 10,
    });
  }

  writeHooks(location.settingsPath, hooks, backupDir, 'settings');
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
