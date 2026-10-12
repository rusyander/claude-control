import { existsSync, renameSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import type {
  CodedMessage,
  ProjectTestAutomationCommand,
  ProjectTestAutomationFormat,
} from '@agentdeck/contracts';
import { codedIf } from '../../../lib/server-text/server-text.ts';
import { ProjectTestsError, readJson, testsPath, writeJson } from '../files.ts';
import { shellArg } from '../e2e-command/e2e-command.ts';
import { isReportDir } from './report.ts';

export { clearReport, collectReport, isReportDir, reportTail } from './report.ts';
export type { CollectedReport } from './report.ts';

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
const FORMATS: readonly ProjectTestAutomationFormat[] = ['junit', 'go-test-json', 'cargo-test'];

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
  return parseAutomation(data);
}

/**
 * Записать команду проекта — те же правила, что у чтения: файл, который панель
 * сама записала, обязан читаться ею же. Негодная — отказ 400 с кодом чтения.
 */
export function writeAutomation(
  root: string,
  input: ProjectTestAutomationCommand,
): ProjectTestAutomationCommand {
  const parsed = parseAutomation({ ...input });
  if (!parsed.automation) {
    const refusal = new ProjectTestsError(parsed.error ?? 'Команда прогона не годится.');
    throw codedIf(refusal, parsed.messageCode, parsed.params);
  }
  writeJson(root, AUTOMATION_FILE, { version: 1, ...parsed.automation });
  return parsed.automation;
}

/**
 * Убрать команду проекта. Файл не стирается, а откладывается рядом
 * (`automation.removed.json`): его могли написать руками, и случайное
 * «Убрать» не должно терять чужую работу.
 */
export function removeAutomation(root: string): void {
  const path = testsPath(root, AUTOMATION_FILE);
  if (!existsSync(path)) return;
  renameSync(path, testsPath(root, 'automation.removed.json'));
}

function parseAutomation(data: unknown): AutomationRead {
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
  const format = raw.format === undefined || raw.format === '' ? 'junit' : raw.format;
  if (!FORMATS.includes(format as ProjectTestAutomationFormat)) {
    // Своего кода у отказа нет: словарь сервера общий с телефоном, а файл с
    // чужим «format» пишут только руками — им хватит причины словами.
    return {
      error: `Неизвестный вид отчёта «${String(format)}»: junit, go-test-json или cargo-test.`,
    };
  }
  if (format !== 'junit' && report.endsWith('/')) {
    return {
      error: 'Каталог отчётов бывает только у JUnit: go-test-json и cargo-test — один файл.',
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
      ...(format !== 'junit' ? { format: format as ProjectTestAutomationFormat } : {}),
    },
  };
}

export interface AutomationCommand {
  line: string;
  cwd: string;
  env: Record<string, string>;
  /** Где искать отчёт этого прогона; кончается разделителем — каталог. */
  report: string;
  format: ProjectTestAutomationFormat;
}

const quote = (value: string): string => (/[\s"'&|<>^]/.test(value) ? `"${value}"` : value);

/**
 * Каталоги пакетов Go для выбранных файлов: `./internal/orders`. Пусто — весь
 * модуль (`./...`): `go test` принимает пакеты, а не файлы, и файлы разных
 * пакетов одним списком он отвергает.
 */
function goPackages(files: string[]): string {
  if (files.length === 0) return './...';
  const dirs = [...new Set(files.map((file) => posix.dirname(file.split(/[\\/]/).join('/'))))];
  // Каталог — из `automation.file`, а его пишет и агент: та же защита от
  // подстановок оболочки, что у `{files}` (F-14).
  return dirs.map((dir) => (dir === '.' ? '.' : shellArg(`./${dir}`))).join(' ');
}

/**
 * Командная строка прогона: подстановки заменены, отчёт назначен. `files` —
 * пути от корня; пусто — `{files}` уходит пустым, и команда гонит весь набор.
 * `whole` — прогон без выбора: `{files}` и тогда несёт файлы (запускателю
 * вроде junit-run весь набор без списка взять неоткуда), а `{paths}` пуст и
 * `{packages}` — `./...`: раннер, который сам собирает тесты (pytest, go),
 * найдёт и те, у которых кейса ещё нет, — иначе «Завести кейсы» после первого
 * раза не видело бы новых тестов, а несобирающийся пакет без кейсов выпадал
 * из прогона молча. С выбором `{paths}` — те же файлы, `{packages}` — их
 * каталоги.
 */
export function automationCommand(
  root: string,
  automation: ProjectTestAutomationCommand,
  files: string[],
  panelReport: string,
  whole = false,
): AutomationCommand {
  // `join` хранит хвостовой разделитель — по нему отчёт и узнаётся каталогом.
  const report = automation.report ? join(root, automation.report) : panelReport;
  const shown = isReportDir(report) ? report.slice(0, -1) : report;
  const line = automation.command
    .replaceAll('{files}', files.map(shellArg).join(' '))
    .replaceAll('{paths}', whole ? '' : files.map(shellArg).join(' '))
    .replaceAll('{packages}', goPackages(whole ? [] : files))
    .replaceAll('{report}', quote(shown))
    .trim();
  return {
    line,
    cwd: root,
    env: { AGENTDECK_JUNIT_REPORT: shown },
    report,
    format: automation.format ?? 'junit',
  };
}
