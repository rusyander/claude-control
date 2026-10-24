import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * Настоящий ли это браузер человека — по фактам, которые не берутся из имени
 * программы (RF-DS-04, повторное ревью 24.10).
 *
 * Чем было раньше и почему заперло владельца. Окно человека узнавалось по
 * оболочке рабочего стола среди ЖИВЫХ предков. Браузер, который работает
 * давно, живого родителя не имеет: Chrome перезапускает свой главный процесс, и
 * тот, кто его открыл, давно вышел. На этой машине 69 из 69 процессов браузеров
 * получали «не узнан» — первое же решение после перезапуска панели отбивалось.
 *
 * Как теперь. Человек — это (1) образ НАСТОЯЩЕЙ установки браузера: путь
 * разрешён до файла и лежит в каталоге установки (копия той же программы в
 * другом месте не подходит, переименованный `node.exe` — тоже); (2) у КОРНЯ
 * браузера (главного процесса той же установки) в командной строке нет ключей
 * автоматизации и отладки — ими браузером правит не человек, а программа;
 * (3) прогона модели среди предков нет (`human-gate.ts`). Мёртвый родитель
 * больше не отказ: он у любого долго работающего браузера.
 *
 * Ключи взяты из исходников, а не из памяти:
 *  · Chromium `content/public/common/content_switches.cc`: remote-debugging-pipe
 *    (596), remote-debugging-port (599), remote-allow-origins (603), test-type
 *    (716), remote-debugging-socket-name (904), enable-automation (923),
 *    remote-debugging-io-pipes (972);
 *  · Chromium `chrome/common/chrome_switches.h`: auto-open-devtools-for-tabs
 *    (122), remote-debugging-targets (645), silent-debugger-extension-api (674),
 *    user-data-dir (776); `chrome/browser/headless/headless_mode_util.cc:24` —
 *    headless; `extensions/common/switches.cc`: load-apps (36), load-extension
 *    (37), extension-test-api-on-web-pages (55);
 *  · Firefox `remote/components/RemoteAgent.sys.mjs`: remote-debugging-port
 *    (200, 212), remote-allow-hosts (220), remote-allow-origins (229);
 *    `Marionette.sys.mjs`: marionette; `toolkit/xre/nsAppRunner.cpp:4602` —
 *    headless и screenshot (тот же безоконный режим); Playwright 1.61.1
 *    (`playwright-core/lib/coreBundle.js`) запускает Firefox с juggler и
 *    juggler-pipe, Chromium — с enable-automation и remote-debugging-pipe.
 * Профиль во временном каталоге (`--user-data-dir` у Chromium, `-profile` у
 * Firefox) — признак одноразового браузера проверки, а не окна человека.
 *
 * Чего это НЕ закрывает (остаток, названный в отчёте): модель может сама
 * открыть настоящий браузер без ключей — или вкладку в уже открытом браузере
 * человека — на странице, которую отдаёт стенд, и страница пошлёт решение.
 * Процесс тогда — честный браузер человека; отличить его клик от запроса
 * страницы по процессам нельзя (RF-DS-08). Safari не поддержан: сеть у него
 * держит служба `com.apple.WebKit.Networking`, её родитель — `launchd`, и к окну
 * браузера она не привязывается. Flatpak и прочие песочницы с чужим деревом
 * файлов — тоже: путь программы виден только внутри песочницы.
 */

export interface BrowserInstall {
  /** Каталог установки — по нему процессы одного браузера узнают друг друга. */
  dir: string;
  /** Главная программа установки (на macOS помощники лежат в той же связке глубже). */
  main: boolean;
}

/** Windows: каталог установки относительно корня программ и имя программы браузера. */
const WINDOWS_INSTALLS: readonly (readonly [string, string])[] = [
  ['Google\\Chrome\\Application', 'chrome.exe'],
  ['Google\\Chrome Beta\\Application', 'chrome.exe'],
  ['Google\\Chrome Dev\\Application', 'chrome.exe'],
  ['Google\\Chrome SxS\\Application', 'chrome.exe'],
  ['Chromium\\Application', 'chrome.exe'],
  ['Microsoft\\Edge\\Application', 'msedge.exe'],
  ['Microsoft\\Edge Beta\\Application', 'msedge.exe'],
  ['Microsoft\\Edge Dev\\Application', 'msedge.exe'],
  ['Microsoft\\Edge SxS\\Application', 'msedge.exe'],
  ['Mozilla Firefox', 'firefox.exe'],
  ['Firefox Developer Edition', 'firefox.exe'],
  ['Firefox Nightly', 'firefox.exe'],
  ['BraveSoftware\\Brave-Browser\\Application', 'brave.exe'],
  ['BraveSoftware\\Brave-Browser-Beta\\Application', 'brave.exe'],
  ['Vivaldi\\Application', 'vivaldi.exe'],
  ['Opera', 'opera.exe'],
  ['Programs\\Opera', 'opera.exe'],
  ['Programs\\Opera GX', 'opera.exe'],
  ['Yandex\\YandexBrowser\\Application', 'browser.exe'],
];

/** Имена программ, у которых стоит читать путь и командную строку (Windows). */
export const WINDOWS_BROWSER_IMAGES: readonly string[] = [
  ...new Set(WINDOWS_INSTALLS.map(([, exe]) => exe)),
];

/**
 * Linux: каталоги пакетов (владелец — root, пользователь туда не пишет).
 * Группа 1 — каталог установки.
 */
const LINUX_INSTALLS: readonly RegExp[] = [
  /^(\/opt\/google\/chrome(?:-beta|-unstable)?)\/chrome$/,
  /^(\/usr\/lib(?:64)?\/chromium(?:-browser)?)\/(?:chromium|chromium-browser|chrome)$/,
  /^(\/usr\/lib(?:64)?\/firefox(?:-esr|-developer-edition)?)\/(?:firefox|firefox-bin|firefox-esr)$/,
  /^(\/opt\/firefox)\/(?:firefox|firefox-bin)$/,
  /^(\/opt\/microsoft\/msedge(?:-beta|-dev)?)\/msedge$/,
  /^(\/opt\/brave\.com\/brave(?:-beta|-nightly)?)\/brave$/,
  /^(\/opt\/vivaldi)\/vivaldi-bin$/,
  /^(\/usr\/lib(?:\/x86_64-linux-gnu)?\/opera)\/opera$/,
  /^(\/opt\/yandex\/browser(?:-beta)?)\/yandex_browser$/,
  /^(\/snap\/firefox\/[^/]+\/usr\/lib\/firefox)\/firefox$/,
  /^(\/snap\/chromium\/[^/]+\/usr\/lib\/chromium-browser)\/chrome$/,
];

/** macOS: связки `.app` браузеров (помощники лежат внутри той же связки). */
const MAC_BUNDLES = [
  'Google Chrome',
  'Google Chrome Beta',
  'Google Chrome Dev',
  'Google Chrome Canary',
  'Chromium',
  'Microsoft Edge',
  'Microsoft Edge Beta',
  'Microsoft Edge Dev',
  'Microsoft Edge Canary',
  'Firefox',
  'Firefox Developer Edition',
  'Firefox Nightly',
  'Brave Browser',
  'Brave Browser Beta',
  'Vivaldi',
  'Opera',
  'Opera GX',
  'Yandex',
  'Arc',
];

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function resolved(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/** Временные каталоги машины: профиль браузера там — признак одноразового запуска. */
export function tempRoots(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string[] {
  const raw =
    platform === 'win32'
      ? [
          tmpdir(),
          env.TEMP,
          env.TMP,
          env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Temp'),
          win32.join(env.SystemRoot ?? 'C:\\Windows', 'Temp'),
        ]
      : [
          tmpdir(),
          env.TMPDIR,
          '/tmp',
          '/var/tmp',
          '/dev/shm',
          '/private/tmp',
          '/private/var/folders',
          '/var/folders',
        ];
  const roots = new Set<string>();
  for (const dir of raw) {
    if (!dir) continue;
    roots.add(normal(dir, platform));
    roots.add(normal(resolved(dir), platform));
  }
  return [...roots];
}

function normal(path: string, platform: string): string {
  return platform === 'win32'
    ? win32
        .normalize(path)
        .replace(/[\\/]+$/, '')
        .toLowerCase()
    : posix.normalize(path).replace(/\/+$/, '');
}

function within(path: string, dir: string, platform: string): boolean {
  const sep = platform === 'win32' ? '\\' : '/';
  return path === dir || path.startsWith(`${dir}${sep}`);
}

/** Корни программ Windows; профиль в temp (одноразовый стенд) корнем не считается. */
function windowsRoots(env: NodeJS.ProcessEnv): string[] {
  const temps = tempRoots(env, 'win32');
  const local = env.LOCALAPPDATA ?? win32.join(homedir(), 'AppData', 'Local');
  return [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, local]
    .filter((dir): dir is string => Boolean(dir))
    .map((dir) => normal(dir, 'win32'))
    .filter((dir) => !temps.some((temp) => within(dir, temp, 'win32')));
}

/**
 * Каталог установки браузера, которому принадлежит программа, — или
 * `undefined`, если это не браузер в своём настоящем месте. `path` уже
 * разрешён (`realpath`): ярлык, соединение каталогов и короткое имя 8.3 сюда не
 * доходят, копия в другом каталоге не совпадёт.
 */
export function browserInstallOf(
  path: string | undefined,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): BrowserInstall | undefined {
  if (!path) return undefined;
  if (platform === 'win32') {
    const file = normal(path, 'win32');
    const exe = win32.basename(file);
    for (const root of windowsRoots(env)) {
      for (const [sub, image] of WINDOWS_INSTALLS) {
        const dir = normal(win32.join(root, sub), 'win32');
        if (exe === image && within(file, dir, 'win32') && file !== dir) {
          return { dir, main: true };
        }
      }
    }
    return undefined;
  }
  if (platform === 'darwin') {
    const roots = ['/Applications', posix.join(home, 'Applications')].map(escape).join('|');
    const names = MAC_BUNDLES.map(escape).join('|');
    const match = new RegExp(`^((?:${roots})/(?:${names})\\.app)/Contents/(.+)$`).exec(path);
    if (!match) return undefined;
    return { dir: match[1] as string, main: /^MacOS\/[^/]+$/.test(match[2] as string) };
  }
  for (const pattern of LINUX_INSTALLS) {
    const match = pattern.exec(path);
    if (match) return { dir: match[1] as string, main: true };
  }
  return undefined;
}

/** Ключи автоматизации и отладки (имена без префикса, в нижнем регистре). */
export const AUTOMATION_SWITCHES: readonly string[] = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-socket-name',
  'remote-debugging-io-pipes',
  'remote-debugging-targets',
  'remote-allow-origins',
  'remote-allow-hosts',
  'enable-automation',
  'test-type',
  'headless',
  'screenshot',
  'auto-open-devtools-for-tabs',
  'silent-debugger-extension-api',
  'load-extension',
  'load-apps',
  'extension-test-api-on-web-pages',
  'marionette',
  'juggler',
  'juggler-pipe',
  'start-debugger-server',
];

/**
 * Ключ ищется в СЫРОЙ командной строке, а не в разборе: разбор Windows
 * (`CommandLineToArgvW`) и наш могут разойтись на кавычках, и ключ, который
 * браузер увидел, а мы — нет, был бы дырой. Граница слева — начало, пробел или
 * кавычка; префиксы — `--`, `-` и `/` (Chromium на Windows принимает все три,
 * Firefox — тоже). Ложное срабатывание на адресе с пробелом перед `-headless`
 * стоит человеку одного отказа; пропуск стоил бы решения.
 */
const AUTOMATION = new RegExp(
  `(?:^|[\\s"'])(?:--|-|/)(${[...AUTOMATION_SWITCHES]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|')})(?=$|[\\s"'=])`,
  'i',
);

/** Процесс-ребёнок браузера: у Chromium `--type=…`, у Firefox `-contentproc`. */
const CHILD = /(?:^|[\s"'])(?:--|-|\/)(?:type=|contentproc(?=$|[\s"']))/i;

export function isBrowserChild(commandLine: string): boolean {
  return CHILD.test(commandLine);
}

/**
 * Значения ключа профиля: `--user-data-dir=<путь>` (Chromium), `-profile <путь>`
 * и `--profile=<путь>` (Firefox). `argv` — разобранная командная строка.
 */
function profileDirs(argv: readonly string[]): string[] {
  const dirs: string[] = [];
  argv.forEach((word, index) => {
    const match = /^(?:--|-|\/)(user-data-dir|profile)(?:=(.*))?$/i.exec(word);
    if (!match) return;
    const value = match[2] ?? (match[1]?.toLowerCase() === 'profile' ? argv[index + 1] : undefined);
    if (value !== undefined) dirs.push(value);
  });
  return dirs;
}

/**
 * Почему корень браузера — не окно человека: имя ключа автоматизации,
 * `temp-profile` или `relative-profile` (профиль с относительным путём не
 * разрешить — рабочий каталог браузера неизвестен). `undefined` — ключей нет.
 */
export function automationOf(
  commandLine: string,
  argv: readonly string[],
  platform: string = process.platform,
  temps: readonly string[] = tempRoots(process.env, platform),
): string | undefined {
  const flag = AUTOMATION.exec(commandLine);
  if (flag) return (flag[1] as string).toLowerCase();
  const paths = platform === 'win32' ? win32 : posix;
  for (const dir of profileDirs(argv)) {
    const value = dir.replace(/^"|"$/g, '');
    if (!paths.isAbsolute(value)) return 'relative-profile';
    const full = normal(resolved(value), platform);
    const plain = normal(value, platform);
    if (temps.some((temp) => within(full, temp, platform) || within(plain, temp, platform))) {
      return 'temp-profile';
    }
  }
  return undefined;
}

/**
 * Разбор командной строки Windows по правилам `CommandLineToArgvW`: первое
 * слово — до кавычки или пробела без особых правил; дальше 2n обратных косых
 * перед кавычкой дают n косых и переключают кавычки, 2n+1 — n косых и саму
 * кавычку. Нужен только для значения профиля: ключи ищутся в сырой строке.
 */
export function splitWindowsCommandLine(text: string): string[] {
  const words: string[] = [];
  let index = 0;
  const skipSpace = () => {
    while (index < text.length && /\s/.test(text[index] as string)) index += 1;
  };
  skipSpace();
  if (index < text.length) {
    let first = '';
    if (text[index] === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') first += text[index++];
      index += 1;
    } else {
      while (index < text.length && !/\s/.test(text[index] as string)) first += text[index++];
    }
    words.push(first);
  }
  for (;;) {
    skipSpace();
    if (index >= text.length) break;
    let word = '';
    let quoted = false;
    while (index < text.length && (quoted || !/\s/.test(text[index] as string))) {
      let slashes = 0;
      while (text[index] === '\\') {
        slashes += 1;
        index += 1;
      }
      if (text[index] === '"') {
        word += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) {
          word += '"';
        } else if (quoted && text[index + 1] === '"') {
          word += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
        index += 1;
      } else {
        word += '\\'.repeat(slashes);
        if (index < text.length && (quoted || !/\s/.test(text[index] as string))) {
          word += text[index];
          index += 1;
        }
      }
    }
    words.push(word);
  }
  return words;
}
