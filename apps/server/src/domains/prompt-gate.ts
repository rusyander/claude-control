import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Hook, PromptGateInfo, PromptGateSettings } from '@claude-control/contracts';
import type { AppStore } from '../lib/app-store.ts';
import { writeTextFile } from '../lib/safe-io.ts';
import { readHooks, writeHooks } from './hooks.ts';
import { readRules } from './dlp/rules-store.ts';
import { buildGateScript } from './prompt-gate/script.ts';

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

function expectedScript(
  location: GateLocation,
  settings: PromptGateSettings,
  journal: boolean,
): string {
  return buildGateScript({
    rulesPath: join(location.appDataDir, RULES_FILE),
    // Журнал у хука и у прокси один. Выключен в настройках прокси — выключен и
    // здесь: два разных ответа на вопрос «ведём ли журнал» запутали бы.
    journalPath: journal ? join(location.appDataDir, JOURNAL_FILE) : '',
    action: settings.action,
  });
}

export function describePromptGate(store: AppStore, location: GateLocation): PromptGateInfo {
  const appSettings = store.getSettings();
  const settings = appSettings.promptGate;
  const scriptPath = gateScriptPath(location.hooksDir);

  const registered = readHooks(location.settingsPath, store).some(
    (hook) => isGateHook(hook) && hook.isEnabled,
  );
  const exists = existsSync(scriptPath);

  let customized = false;
  if (exists) {
    try {
      customized =
        readFileSync(scriptPath, 'utf8') !==
        expectedScript(location, settings, appSettings.dlp.journal);
    } catch {
      customized = true;
    }
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
 */
export function applyPromptGate(
  store: AppStore,
  location: GateLocation,
  settings: PromptGateSettings,
  options: { force?: boolean; backupDir?: string } = {},
): PromptGateInfo {
  const scriptPath = gateScriptPath(location.hooksDir);
  const journal = store.getSettings().dlp.journal;

  if (settings.enabled) {
    const wanted = expectedScript(location, settings, journal);
    const current = existsSync(scriptPath) ? safeRead(scriptPath) : undefined;
    if (current === undefined || options.force || current === wanted) {
      writeTextFile(scriptPath, wanted, { backupDir: options.backupDir });
    }
    registerHook(store, location, true, options.backupDir);
  } else {
    registerHook(store, location, false, options.backupDir);
    // Свою правку не выбрасываем: снятие регистрации уже выключило хук, а файл
    // человек может забрать себе.
    if (
      existsSync(scriptPath) &&
      safeRead(scriptPath) === expectedScript(location, settings, journal)
    ) {
      rmSync(scriptPath, { force: true });
    }
  }

  return describePromptGate(store, location);
}

function registerHook(
  store: AppStore,
  location: GateLocation,
  present: boolean,
  backupDir?: string,
): void {
  const hooks = readHooks(location.settingsPath, store).filter((hook) => !isGateHook(hook));

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
