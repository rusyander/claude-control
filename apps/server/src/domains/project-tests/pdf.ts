import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectCliOnPath, pathExists } from '../../providers/detect.ts';
import { ProjectTestsError, ProjectTestsUnavailableError } from './files.ts';
import { brandEnv, brandEnvName } from '../../lib/brand.mjs';
import { coded } from '../../lib/server-text.ts';
import { serverText } from '../../lib/server-texts.ts';

/**
 * PDF отчёта — тем браузером, который уже стоит на машине.
 *
 * Своего движка вёрстки панель не заводит: печать HTML умеет любой Chromium, и
 * ставить ради одной страницы `puppeteer` (сто мегабайт своего браузера) или
 * серверный генератор PDF значит платить постоянную цену за редкую кнопку.
 * Ищем по тому же правилу, что и провайдерские CLI (`providers/detect.ts`):
 * сначала имя в PATH, потом известные места установки — и НИКОГДА не падаем в
 * процессе поиска.
 *
 * Браузера нет — это честный 501 с именами того, что можно поставить, а не
 * пустой или битый файл: отчёт, который не открывается, хуже отсутствующего.
 */

/** Переопределение для нестандартной установки — путь к браузеру. */
const OVERRIDE_ENV = brandEnvName('CHROME');

/** Сколько ждём печать: страница локальная, дольше — значит браузер завис. */
const RENDER_TIMEOUT_MS = 45_000;

/** Имена в PATH — по порядку предпочтения. */
const COMMANDS: Record<string, string[]> = {
  win32: ['chrome', 'msedge', 'chromium', 'brave'],
  darwin: ['google-chrome', 'chromium', 'microsoft-edge', 'brave'],
  linux: [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
  ],
};

/** Известные места установки — их проверяем, только если в PATH ничего нет. */
function knownPaths(): string[] {
  if (process.platform === 'win32') {
    const program = process.env.ProgramFiles ?? 'C:\\Program Files';
    const program86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA ?? '';
    return [
      join(program, 'Google/Chrome/Application/chrome.exe'),
      join(program86, 'Google/Chrome/Application/chrome.exe'),
      local ? join(local, 'Google/Chrome/Application/chrome.exe') : '',
      join(program, 'Microsoft/Edge/Application/msedge.exe'),
      join(program86, 'Microsoft/Edge/Application/msedge.exe'),
      join(program, 'Chromium/Application/chrome.exe'),
    ].filter(Boolean);
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ];
}

/** Что можно поставить, если ничего не нашлось, — текст для человека. */
export const NO_BROWSER_MESSAGE = serverText('tests-pdf-no-browser', { env: OVERRIDE_ENV });

/** Подменяемые зависимости поиска — тест не должен зависеть от машины. */
export interface BrowserDeps {
  detectCli?: (command: string) => boolean;
  exists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Браузер семейства Chromium на этой машине — команда или путь. Ничего не
 * нашлось → `undefined`; решение, что с этим делать, принимает вызывающий.
 */
export function findChromium(deps: BrowserDeps = {}): string | undefined {
  const detect = deps.detectCli ?? detectCliOnPath;
  const exists = deps.exists ?? pathExists;
  const override = brandEnv('CHROME', deps.env ?? process.env)?.trim();
  if (override) return exists(override) ? override : undefined;

  const names = COMMANDS[process.platform] ?? COMMANDS.linux ?? [];
  const found = names.find((name) => detect(name));
  if (found) return found;

  return knownPaths().find((path) => exists(path));
}

/** Запуск браузера — подменяется в тестах, чтобы не печатать по-настоящему. */
export type Renderer = (browser: string, args: string[]) => Promise<{ code: number; err: string }>;

const spawnRenderer: Renderer = (browser, args) =>
  new Promise((done) => {
    const child = spawn(browser, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    const timer = setTimeout(() => child.kill(), RENDER_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ code: -1, err: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, err: stderr.join('').trim() });
    });
  });

/**
 * Напечатать HTML в PDF.
 *
 * Печатаем ИЗ ФАЙЛА и в СВОЁМ профиле (`--user-data-dir`): без отдельного
 * профиля запуск присоединяется к уже открытому окну браузера пользователя, и
 * команда печати тихо уходит в никуда — процесс завершается нулём, а файла нет.
 */
export async function renderPdf(
  html: string,
  deps: BrowserDeps & { render?: Renderer } = {},
): Promise<Buffer> {
  const browser = findChromium(deps);
  if (!browser)
    throw coded(new ProjectTestsUnavailableError(NO_BROWSER_MESSAGE), 'pdf-no-browser', {
      env: OVERRIDE_ENV,
    });

  const dir = mkdtempSync(join(tmpdir(), 'cc-report-'));
  const page = join(dir, 'report.html');
  const out = join(dir, 'report.pdf');
  try {
    writeFileSync(page, html, 'utf8');
    const { code, err } = await (deps.render ?? spawnRenderer)(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${join(dir, 'profile')}`,
      '--no-pdf-header-footer',
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=4000',
      `--print-to-pdf=${out}`,
      `file://${page.replace(/\\/g, '/')}`,
    ]);

    if (!existsSync(out)) {
      throw coded(
        new ProjectTestsError(
          `Браузер не напечатал отчёт (код ${code})${err ? `: ${err.slice(-400)}` : ''}.`,
        ),
        'pdf-print-failed',
        { code: String(code), detail: err ? `: ${err.slice(-400)}` : '' },
      );
    }
    const body = readFileSync(out);
    if (body.byteLength === 0)
      throw coded(new ProjectTestsError('Браузер вернул пустой PDF.'), 'pdf-empty');
    return body;
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
