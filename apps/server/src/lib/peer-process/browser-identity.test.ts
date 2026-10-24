import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_SWITCHES,
  automationOf,
  browserInstallOf,
  isBrowserChild,
  splitWindowsCommandLine,
} from './browser-identity.ts';

/**
 * Браузер человека узнаётся по месту установки и ключам запуска корня
 * (RF-DS-04). Проверка — на настоящих путях установок и на ключах, которыми
 * Playwright и драйверы запускают браузер.
 */

const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramW6432: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local',
  TEMP: 'C:\\Users\\owner\\AppData\\Local\\Temp',
};

const TEMPS = ['c:\\users\\owner\\appdata\\local\\temp'];

describe('browser install', () => {
  it.each([
    ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'chrome'],
    ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'edge'],
    ['C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'firefox'],
    ['C:\\Users\\owner\\AppData\\Local\\Yandex\\YandexBrowser\\Application\\browser.exe', 'yandex'],
    ['C:\\Users\\owner\\AppData\\Local\\Programs\\Opera\\112.0.5197.53\\opera.exe', 'opera'],
    ['c:\\program files\\google\\chrome\\application\\CHROME.EXE', 'case'],
  ])('Windows: %s is an install (%s)', (path) => {
    expect(browserInstallOf(path, 'win32', WIN_ENV)).toMatchObject({ main: true });
  });

  it.each([
    // Копия той же программы вне каталога установки.
    'C:\\work\\copy\\chrome.exe',
    // Безоконная оболочка и Chromium Playwright — в кэше Playwright, не в установке.
    'C:\\Users\\owner\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1200\\chrome-win\\headless_shell.exe',
    'C:\\Users\\owner\\AppData\\Local\\ms-playwright\\chromium-1200\\chrome-win\\chrome.exe',
    // Чужая программа в каталоге браузера.
    'C:\\Program Files\\Google\\Chrome\\Application\\node.exe',
    'C:\\Program Files\\nodejs\\node.exe',
  ])('Windows: %s is not', (path) => {
    expect(browserInstallOf(path, 'win32', WIN_ENV)).toBeUndefined();
  });

  it('Windows: a LOCALAPPDATA inside temp (a throwaway stand) is not an install root', () => {
    const env = { ...WIN_ENV, LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local\\Temp\\cc-x\\Local' };
    const path =
      'C:\\Users\\owner\\AppData\\Local\\Temp\\cc-x\\Local\\Google\\Chrome\\Application\\chrome.exe';
    expect(browserInstallOf(path, 'win32', env)).toBeUndefined();
  });

  it('Windows: processes of one install share the install dir', () => {
    const a = browserInstallOf(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'win32',
      WIN_ENV,
    );
    const b = browserInstallOf(
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'win32',
      WIN_ENV,
    );
    expect(a?.dir).toBe('c:\\program files\\google\\chrome\\application');
    expect(a?.dir).not.toBe(b?.dir);
  });

  it.each([
    '/opt/google/chrome/chrome',
    '/usr/lib/firefox/firefox',
    '/usr/lib64/chromium-browser/chromium-browser',
    '/snap/firefox/4793/usr/lib/firefox/firefox',
    '/opt/microsoft/msedge/msedge',
  ])('Linux: %s is an install', (path) => {
    expect(browserInstallOf(path, 'linux')).toMatchObject({ main: true });
  });

  it.each(['/home/owner/chrome/chrome', '/tmp/opt/google/chrome/chrome', '/usr/bin/node'])(
    'Linux: %s is not',
    (path) => expect(browserInstallOf(path, 'linux')).toBeUndefined(),
  );

  it('macOS: the main program and its helper share the bundle; only the main is the root', () => {
    const main = browserInstallOf(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      'darwin',
      {},
      '/Users/owner',
    );
    const helper = browserInstallOf(
      '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/130/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper',
      'darwin',
      {},
      '/Users/owner',
    );
    expect(main).toEqual({ dir: '/Applications/Google Chrome.app', main: true });
    expect(helper).toEqual({ dir: '/Applications/Google Chrome.app', main: false });
    expect(
      browserInstallOf(
        '/Users/owner/Applications/Firefox.app/Contents/MacOS/firefox',
        'darwin',
        {},
        '/Users/owner',
      ),
    ).toMatchObject({ main: true });
  });

  it('macOS: a copied bundle elsewhere and Safari are not installs', () => {
    expect(
      browserInstallOf(
        '/Users/owner/Desktop/Google Chrome.app/Contents/MacOS/Google Chrome',
        'darwin',
        {},
        '/Users/owner',
      ),
    ).toBeUndefined();
    expect(
      browserInstallOf(
        '/Applications/Safari.app/Contents/MacOS/Safari',
        'darwin',
        {},
        '/Users/owner',
      ),
    ).toBeUndefined();
  });
});

describe('automation switches of the browser root', () => {
  const ROOT = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';
  const judge = (line: string) => automationOf(line, splitWindowsCommandLine(line), 'win32', TEMPS);

  it('the owner browser as Windows starts it carries none', () => {
    expect(judge(ROOT)).toBeUndefined();
    expect(judge(`${ROOT} --no-startup-window /prefetch:5`)).toBeUndefined();
    expect(
      judge(`${ROOT} --profile-directory=Default https://example.com/headless-cms`),
    ).toBeUndefined();
    expect(judge(`${ROOT} --user-data-dir=C:\\work\\profiles\\second`)).toBeUndefined();
  });

  it.each(AUTOMATION_SWITCHES.map((name) => [name]))('--%s refuses the root', (name) => {
    expect(judge(`${ROOT} --${name}`)).toBe(name);
    expect(judge(`${ROOT} --${name}=1`)).toBe(name);
  });

  it('every prefix and case Chromium and Firefox accept is caught', () => {
    expect(judge(`${ROOT} -remote-debugging-port=9222`)).toBe('remote-debugging-port');
    expect(judge(`${ROOT} /Enable-Automation`)).toBe('enable-automation');
    expect(judge(`${ROOT} "--remote-debugging-pipe"`)).toBe('remote-debugging-pipe');
    expect(judge('firefox.exe -juggler-pipe -no-remote')).toBe('juggler-pipe');
    expect(judge('firefox.exe --marionette')).toBe('marionette');
  });

  it('the Playwright launch lines are refused', () => {
    const chromium =
      `${ROOT} --disable-field-trial-config --enable-automation --headless --no-sandbox ` +
      '--user-data-dir=C:\\Users\\owner\\AppData\\Local\\Temp\\playwright_chromiumdev_profile-x --remote-debugging-pipe about:blank';
    expect(judge(chromium)).toBe('enable-automation');
    const headful = `${ROOT} --test-type= --no-startup-window`;
    expect(judge(headful)).toBe('test-type');
  });

  it('a profile in temp is a throwaway browser; a relative one cannot be judged', () => {
    expect(judge(`${ROOT} --user-data-dir=C:\\Users\\owner\\AppData\\Local\\Temp\\p1`)).toBe(
      'temp-profile',
    );
    expect(judge(`${ROOT} "--user-data-dir=C:\\Users\\owner\\AppData\\Local\\Temp\\p 2"`)).toBe(
      'temp-profile',
    );
    expect(judge('firefox.exe -profile C:\\Users\\owner\\AppData\\Local\\Temp\\ff')).toBe(
      'temp-profile',
    );
    expect(judge(`${ROOT} --user-data-dir=profile`)).toBe('relative-profile');
    expect(
      automationOf(
        '/opt/google/chrome/chrome --user-data-dir=/tmp/x',
        ['/opt/google/chrome/chrome', '--user-data-dir=/tmp/x'],
        'linux',
        ['/tmp'],
      ),
    ).toBe('temp-profile');
  });

  it('children of a browser are told apart from its root', () => {
    expect(
      isBrowserChild(`${ROOT} --type=utility --utility-sub-type=network.mojom.NetworkService`),
    ).toBe(true);
    expect(isBrowserChild('firefox.exe -contentproc --channel=1 -isForBrowser')).toBe(true);
    expect(isBrowserChild(`${ROOT} --no-startup-window`)).toBe(false);
  });
});

describe('Windows command line split (CommandLineToArgvW rules)', () => {
  it.each([
    ['"C:\\Program Files\\a.exe" --x=1 "b c"', ['C:\\Program Files\\a.exe', '--x=1', 'b c']],
    ['a.exe "--user-data-dir=C:\\p q\\"', ['a.exe', '--user-data-dir=C:\\p q"']],
    ['a.exe x\\\\"y z"', ['a.exe', 'x\\y z']],
    ['a.exe C:\\dir\\ next', ['a.exe', 'C:\\dir\\', 'next']],
    ['a.exe "say ""hi"""', ['a.exe', 'say "hi"']],
  ])('%s', (line, words) => expect(splitWindowsCommandLine(line)).toEqual(words));
});
