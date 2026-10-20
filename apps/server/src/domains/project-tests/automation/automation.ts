import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix } from 'node:path';
import type {
  CodedMessage,
  ProjectTestAutomationCommand,
  ProjectTestAutomationFormat,
} from '@agentdeck/contracts';
import { codedIf } from '../../../lib/server-text/server-text.ts';
import { shellQuote } from '../../../lib/shell-quote.ts';
import { ProjectTestsError, readJson, testsPath, writeJson } from '../files.ts';
import { shellArg } from '../e2e-command/e2e-command.ts';
import { isReportDir } from './report.ts';
import { goModuleDirs } from './recipes.ts';

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
  /** Столько путей ушло файлом `RUN_FILES_ENV`, а не строкой: она бы не запустилась. */
  listed?: number;
}

/**
 * Длиннее строку не запустить: `shell: true` на Windows идёт через cmd.exe, а он
 * режет команду на 8191 знаке («Слишком длинная командная строка») — прогон 300
 * наборов падал за 0 с без отчёта, и ни один кейс не получал итога.
 */
export const COMMAND_LINE_LIMIT = 8000;

/** Путь к файлу со списком прогона (по строке на путь), когда он не влез в строку. */
export const RUN_FILES_ENV = 'AGENTDECK_TEST_FILES';

const quote = (value: string): string => shellQuote(value);

/**
 * Каталоги пакетов Go для выбранных файлов: `./internal/orders`. Пусто — весь
 * модуль (`./...`): `go test` принимает пакеты, а не файлы, и файлы разных
 * пакетов одним списком он отвергает.
 */
function goPackages(files: string[]): string {
  if (files.length === 0) return './...';
  const dirs = [...new Set(files.map(packageDir))];
  // Каталог — из `automation.file`, а его пишет и агент: та же защита от
  // подстановок оболочки, что у `{files}` (F-14).
  return dirs.map((dir) => (dir === '.' ? '.' : shellArg(`./${dir}`))).join(' ');
}

/** Каталог пакета файла кейса; у кейса-набора `file` — сам каталог (`dir/`). */
function packageDir(file: string): string {
  const path = file.split(/[\\/]/).join('/');
  return path.endsWith('/') ? path.slice(0, -1) || '.' : posix.dirname(path);
}

/**
 * `{go-modules}` — все модули Go проекта одной цепочкой, для репозитория из
 * многих `go.mod` без `go.work`. `go test -C <модуль>` дописывает отчёт по
 * очереди; `|| echo -` не даёт провалу модуля оборвать цепочку, красное видно
 * по отчёту. Звено — в скобках: cmd читает `A || echo - && B` как
 * `A || (echo - && B)`, и после зелёного первого модуля остальные не
 * запускались вовсе (19.10.2026); `(A || echo -) && (B || echo -)` одинаково
 * читают и cmd, и sh. Скобка без кавычек в пути сломала бы это в cmd — `quote`
 * её кавычит. С выбором —
 * только модули выбранных кейсов и только их пакеты: агенту после правки одного
 * пакета не нужен прогон всего репозитория.
 */
function goModulesChain(root: string, files: string[], report: string): string {
  const modules = goModuleDirs(root).sort((a, b) => b.length - a.length);
  const picked = new Map<string, Set<string>>();
  if (files.length === 0) {
    for (const dir of modules) picked.set(dir, new Set(['./...']));
  } else {
    for (const file of files) {
      const dir = packageDir(file);
      const module = modules.find((item) => !item || dir === item || dir.startsWith(`${item}/`));
      if (module === undefined) continue;
      const inside = module ? dir.slice(module.length).replace(/^\//, '') : dir;
      const rel = inside === '.' ? '' : inside;
      const packages = picked.get(module) ?? new Set<string>();
      packages.add(rel ? shellArg(`./${rel}`) : '.');
      picked.set(module, packages);
    }
  }
  const links = [...picked]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, packages], index) => {
      const at = module ? shellArg(module) : '.';
      const into = index === 0 ? '>' : '>>';
      return `go test -C ${at} -json ${[...packages].join(' ')} ${into} ${quote(report)} || echo -`;
    });
  return links.length > 1 ? links.map((link) => `(${link})`).join(' && ') : (links[0] ?? '');
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
 *
 * Строка длиннее `COMMAND_LINE_LIMIT` собирается как прогон без выбора (весь
 * набор раннера), а точный список ложится файлом рядом с отчётом панели и
 * называется в `RUN_FILES_ENV`: junit-run берёт его оттуда, прочий раннер гонит
 * всё — лишние итоги лучше прогона, который не стартует вовсе.
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
  const build = (picked: string[], all: boolean): string =>
    automation.command
      .replaceAll('{files}', picked.map(shellArg).join(' '))
      .replaceAll('{paths}', all ? '' : picked.map(shellArg).join(' '))
      .replaceAll('{packages}', goPackages(all ? [] : picked))
      .replaceAll('{go-modules}', () => goModulesChain(root, all ? [] : picked, shown))
      .replaceAll('{report}', quote(shown))
      .trim();
  const own: AutomationCommand = {
    line: build(files, whole),
    cwd: root,
    env: { AGENTDECK_JUNIT_REPORT: shown },
    report,
    format: automation.format ?? 'junit',
  };
  if (own.line.length <= COMMAND_LINE_LIMIT || files.length === 0) return own;
  const list = `${panelReport.replace(/[\\/]+$/, '')}.files.txt`;
  mkdirSync(dirname(list), { recursive: true });
  writeFileSync(list, `${files.join('\n')}\n`, 'utf8');
  return {
    ...own,
    line: build([], true),
    env: { ...own.env, [RUN_FILES_ENV]: list },
    listed: files.length,
  };
}
