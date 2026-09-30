import { isAbsolute, join, posix } from 'node:path';
import type { CodedMessage, ProjectTestAutomationCommand } from '@agentdeck/contracts';
import { readJson } from './files.ts';
import { shellArg } from './e2e-command.ts';

/**
 * Своя команда прогона проекта — `.agent/tests/automation.json`.
 *
 * Папка Playwright/Cypress/pytest — не единственный вид автотестов: у самой
 * панели это скрипты `tools/qa/*.mjs` и наборы vitest, которые переводит в JUnit
 * `tools/qa/junit-run.mjs`. Угадывать такую команду панель не берётся — проект
 * называет её сам, одной строкой, и дальше её зовут все: кнопка «Прогнать
 * автотесты», `tests-cli run` без `--cmd` и агент чата.
 *
 * Модуль без зависимостей от реестра прогонов: его грузит и CLI.
 */

export const AUTOMATION_FILE = 'automation.json';

const MAX_COMMAND = 2000;
const MAX_TIMEOUT_MINUTES = 240;

export interface AutomationRead extends CodedMessage {
  automation?: ProjectTestAutomationCommand;
  /**
   * Файл есть, но не годится: причина словами для CLI; окно настроек называет
   * её по `messageCode` на языке интерфейса (F-356).
   */
  error?: string;
}

/** Прочитать команду проекта. Нет файла — `{}`: это обычный случай, а не ошибка. */
export function readAutomation(root: string): AutomationRead {
  const { data, error, messageCode, params } = readJson(root, AUTOMATION_FILE);
  if (error) return { error, messageCode, ...(params ? { params } : {}) };
  if (data === undefined) return {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      error: 'Файл команды прогона — не объект JSON.',
      messageCode: 'automation-not-object',
    };
  }
  const raw = data as Record<string, unknown>;
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (!command) {
    return {
      error: 'В файле команды прогона нет строки «command».',
      messageCode: 'automation-command-missing',
    };
  }
  if (command.length > MAX_COMMAND) {
    return {
      error: `Команда прогона длиннее ${MAX_COMMAND} символов.`,
      messageCode: 'automation-command-too-long',
      params: { max: MAX_COMMAND },
    };
  }
  if (/[\r\n]/.test(command)) {
    return {
      error: 'Команда прогона — одна строка, без переводов.',
      messageCode: 'automation-command-multiline',
    };
  }
  const report = typeof raw.report === 'string' ? raw.report.trim() : '';
  if (report && (isAbsolute(report) || report.split(/[\\/]/).includes('..'))) {
    return {
      error: 'Путь отчёта в команде прогона — от корня проекта и внутри него.',
      messageCode: 'automation-report-outside',
    };
  }
  const minutes = Number(raw.timeoutMinutes);
  const timeoutMinutes =
    Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, MAX_TIMEOUT_MINUTES) : undefined;
  return {
    automation: {
      command,
      // Разделители — оба, на любой ОС, как и в проверке выше: файл лежит в
      // репозитории проекта, и `out\junit.xml`, записанный на Windows, на
      // Linux по `sep` остался бы именем файла с обратным слэшем внутри.
      ...(report ? { report: report.split(/[\\/]/).join(posix.sep) } : {}),
      ...(timeoutMinutes ? { timeoutMinutes } : {}),
    },
  };
}

export interface AutomationCommand {
  line: string;
  cwd: string;
  env: Record<string, string>;
  /** Где искать отчёт этого прогона. */
  report: string;
}

const quote = (value: string): string => (/[\s"'&|<>^]/.test(value) ? `"${value}"` : value);

/**
 * Командная строка прогона: подстановки заменены, отчёт назначен. `files` —
 * пути от корня; пусто — `{files}` уходит пустым, и команда гонит весь набор.
 */
export function automationCommand(
  root: string,
  automation: ProjectTestAutomationCommand,
  files: string[],
  panelReport: string,
): AutomationCommand {
  const report = automation.report ? join(root, automation.report) : panelReport;
  const line = automation.command
    .replaceAll('{files}', files.map(shellArg).join(' '))
    .replaceAll('{report}', quote(report))
    .trim();
  return { line, cwd: root, env: { AGENTDECK_JUNIT_REPORT: report }, report };
}
