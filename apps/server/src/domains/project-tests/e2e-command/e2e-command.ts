import { existsSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import type { ProjectTestE2eFolder } from '@agentdeck/contracts';
import { coded } from '../../../lib/server-text/server-text.ts';
import { ProjectTestsError } from '../files.ts';

/**
 * Команда прогона папки e2e — одна на всех, кто её запускает: кнопка панели
 * (`e2e-run.ts`), `tests-cli run` без `--cmd` и задание генерации агенту.
 *
 * Одна — потому что три копии уже разошлись однажды: агенту советовали путь
 * отчёта, который Playwright разрешал от каталога конфига (`e2e/e2e/results`),
 * а чату — запуск из корня, где `npx` брал чужую версию Playwright и не находил
 * тестов. Модуль без зависимостей от реестра прогонов: его грузит и CLI.
 */

export interface E2eCommand {
  /** Командная строка для оболочки. */
  line: string;
  /** Каталог запуска. */
  cwd: string;
  /** Переменные, которыми каркас узнаёт путь отчёта. */
  env: Record<string, string>;
  /**
   * Исполняемый файл раннера в `node_modules/.bin`: без него команда не
   * запускается. `npx` без него СКАЧАЛ бы раннер последней версии — однажды это
   * были 0,8 ГБ Cypress без спроса; `--no-install` стоит на случай, если проверка
   * ошиблась, а отказ словами — вместо загрузки.
   */
  bin?: string;
  /** Что выполнить человеку, если раннера нет. */
  install: string;
}

const quote = (value: string): string => `"${value.replace(/"/g, '\\"')}"`;

/**
 * Что оболочка раскрывает и внутри двойных кавычек: `$()`/`$VAR` и обратная
 * кавычка у sh, `%VAR%` и `!VAR!` у cmd, сама кавычка закрывает аргумент, а
 * перевод строки начинает новую команду.
 */
const SHELL_EXPANDS = /["`$%!\r\n\0]/;

/**
 * Путь файла автотеста — аргументом строки для `shell: true`. Путь пишет агент,
 * человек или импорт (`automation.file`), так что `x$(touch pwned).spec.ts` —
 * это команда, а не имя: такой путь отказом словами. `\` → `/` (путь одинаков
 * для sh и cmd); путь не только из букв, цифр и `./:@+-` — в двойных кавычках
 * целиком, и `;`, `&`, `|`, `*`, `,` (разделитель аргументов у `.cmd`) в них —
 * просто буквы.
 */
export function shellArg(value: string): string {
  if (SHELL_EXPANDS.test(value)) {
    throw coded(
      new ProjectTestsError(
        `В имени файла автотеста ${JSON.stringify(value)} есть символ, который оболочка раскроет, — переименуйте файл.`,
      ),
      'e2e-run-file-unsafe',
      { file: value },
    );
  }
  const path = value.replace(/\\/g, '/');
  return /^[\w./:@+-]+$/.test(path) ? path : `"${path}"`;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Файл для Playwright. Позиционный аргумент у него — регулярка по абсолютному
 * пути, без якорей и без учёта регистра: `cart.spec.ts` прогонял и
 * `mycart.spec.ts`, и `cart.spec.tsx`. Здесь — путь от корня проекта,
 * экранированный и привязанный к концу пути (`/…$/` Playwright берёт как
 * регулярку как есть). `$` и `^` — буквы в кавычках своей оболочки: в двойных у
 * cmd, в одинарных у sh; символы, которые оболочка раскроет, отказаны `shellArg`.
 */
export function playwrightFileArg(file: string, platform = process.platform): string {
  shellArg(file);
  const path = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const pattern = `/(^|/)${path.replace(REGEX_SPECIAL, '\\$&')}$/${platform === 'win32' ? 'i' : ''}`;
  return platform === 'win32' ? `"${pattern}"` : `'${pattern.replace(/'/g, `'\\''`)}'`;
}

/**
 * Интерпретатор Python для строки pytest. На Windows — `python` (`python3` там —
 * заглушка магазина); на macOS и Linux `python` часто нет вовсе, а `python3`
 * есть везде, и в venv заведены оба имени.
 */
export function pythonFor(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'python' : 'python3';
}

const PLAYWRIGHT_CONFIGS = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];

const toPosix = (path: string): string => path.split(sep).join(posix.sep);

/**
 * Команда прогона по каркасу папки. `undefined` — каркас неизвестен, и
 * угадывать команду панель не берётся: запуск чужого кода вслепую хуже отказа.
 *
 * `files` — пути от корня проекта: прогнать только их (группа в `tests-cli run`).
 * Без них — вся папка.
 */
export function e2eCommand(
  root: string,
  folder: ProjectTestE2eFolder,
  report: string,
  files: string[] = [],
): E2eCommand | undefined {
  if (!folder.dir) return undefined;
  const dir = join(root, folder.dir);
  if (folder.framework === 'playwright') {
    // Конфиг внутри папки (заготовка панели) — запуск из неё; иначе из корня,
    // где лежит конфиг проекта, с папкой аргументом.
    const own = PLAYWRIGHT_CONFIGS.some((name) => existsSync(join(dir, name)));
    const atRoot = PLAYWRIGHT_CONFIGS.some((name) => existsSync(join(root, name)));
    const cwd = own ? dir : root;
    const wholeFolder = own || atRoot ? [] : [quote(folder.dir)];
    const targets = files.length > 0 ? files.map((file) => playwrightFileArg(file)) : wholeFolder;
    return {
      line: ['npx --no-install playwright test', ...targets, '--reporter=list,junit'].join(' '),
      cwd,
      bin: 'playwright',
      install: 'npm install && npx playwright install chromium',
      // INCLUDE_RETRIES: упавшие попытки зелёного теста уходят в отчёт
      // `<flakyFailure>` — без них «прошёл на повторе» неотличим от зелёного, и
      // карантину нечего предложить. Повторы включает конфиг проекта, не панель.
      env: {
        PLAYWRIGHT_JUNIT_OUTPUT_FILE: report,
        PLAYWRIGHT_JUNIT_OUTPUT_NAME: report,
        PLAYWRIGHT_JUNIT_INCLUDE_RETRIES: '1',
      },
    };
  }
  if (folder.framework === 'cypress') {
    const spec = files.length > 0 ? ` --spec ${shellArg(files.join(','))}` : '';
    return {
      line: `npx --no-install cypress run${spec} --reporter junit --reporter-options ${quote(`mochaFile=${report}`)}`,
      cwd: root,
      env: {},
      bin: 'cypress',
      install: 'npm install --save-dev cypress',
    };
  }
  if (folder.framework === 'pytest') {
    const targets = (files.length > 0 ? files.map(shellArg) : [quote(folder.dir)]).join(' ');
    return {
      line: `${pythonFor()} -m pytest ${targets} -q ${quote(`--junitxml=${report}`)}`,
      cwd: root,
      env: {},
      install: `${pythonFor()} -m pip install pytest`,
    };
  }
  return undefined;
}

/**
 * Где лежит установленный раннер: `node_modules/.bin` от каталога запуска вверх,
 * как ищет сам `npx`. `undefined` — не установлен.
 */
export function installedBin(cwd: string, bin: string): string | undefined {
  const names = process.platform === 'win32' ? [`${bin}.cmd`, bin] : [bin];
  for (let dir = cwd; ; dir = dirname(dir)) {
    for (const name of names) {
      const path = join(dir, 'node_modules', '.bin', name);
      if (existsSync(path)) return path;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Раннер не нашёлся уже в выводе: npx отказался качать, у python нет pytest. */
export const NOT_INSTALLED =
  /canceled due to missing packages|could not determine executable to run|No module named pytest|python3?: (?:command )?not found|'python3?' is not recognized/i;

/** Каталог запуска от корня проекта — для подсказки «где выполнить». */
export function runDirOf(root: string, command: Pick<E2eCommand, 'cwd'> | undefined): string {
  return toPosix(relative(root, command?.cwd ?? root)) || '.';
}

/**
 * Команда одной строкой для bash — так её получает агент: каталог, переменные
 * отчёта и сама команда. Bash, а не cmd: инструмент оболочки Claude Code — bash
 * и на Windows (Git Bash).
 */
export function shellLine(command: E2eCommand): string {
  const env = Object.entries(command.env)
    .filter(([key]) => key !== 'PLAYWRIGHT_JUNIT_OUTPUT_NAME')
    .map(([key, value]) => `${key}=${quote(toPosix(value))}`);
  return [`cd ${quote(toPosix(command.cwd))} &&`, ...env, command.line].join(' ');
}
