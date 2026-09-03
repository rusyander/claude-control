import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Hook, PromptGateInfo, PromptGateSettings } from '@claude-control/contracts';
import type { AppStore } from '../lib/app-store.ts';
import { writeTextFile } from '../lib/safe-io.ts';
import { readHooks, writeHooks } from './hooks.ts';
import { readRules } from './dlp/rules-store.ts';
import { buildGateScript, type GateScriptConfig } from './prompt-gate/script.ts';

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

const SCRIPT_NAME = 'claude-control-prompt-gate.mjs';
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

function isGateHook(hook: Hook): boolean {
  return hook.event === 'UserPromptSubmit' && hook.command.includes(SCRIPT_NAME);
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
  const match = /^const CONFIG = (\{[\s\S]*?\n\});$/m.exec(source);
  if (!match?.[1]) return false;
  try {
    const config = JSON.parse(match[1]) as GateScriptConfig;
    return buildGateScript(config) === source;
  } catch {
    return false;
  }
}

export function describePromptGate(store: AppStore, location: GateLocation): PromptGateInfo {
  const settings = store.getSettings().promptGate;
  const scriptPath = gateScriptPath(location.hooksDir);

  const registered = readHooks(location.settingsPath, store).some(
    (hook) => isGateHook(hook) && hook.isEnabled,
  );
  const exists = existsSync(scriptPath);

  let customized = false;
  if (exists) {
    const current = safeRead(scriptPath);
    customized = current === undefined || !isPanelScript(current);
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

  if (settings.enabled) {
    const wanted = expectedScript(location, settings);
    if ((current === undefined || options.force || ours) && current !== wanted) {
      writeTextFile(scriptPath, wanted, { backupDir: options.backupDir });
    }
    registerHook(store, location, true, options.backupDir);
  } else {
    registerHook(store, location, false, options.backupDir);
    // Свою правку не выбрасываем: снятие регистрации уже выключило хук, а файл
    // человек может забрать себе.
    if (ours) rmSync(scriptPath, { force: true });
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

  // Нечего менять — не трогаем settings.json: смена действия при выключенном
  // гейте иначе переписывала бы чужой конфиг (и плодила резервные копии) зря.
  if (registered === present) return;

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
