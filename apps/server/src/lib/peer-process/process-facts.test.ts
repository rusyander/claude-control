import { describe, expect, it } from 'vitest';
import {
  isRemoteProxy,
  parseCim,
  parsePs,
  parseTasklist,
  readProcessFacts,
  type FactsIo,
} from './process-facts.ts';

/**
 * Факты ОС о процессах — основа решения «на том конце человек или модель»
 * (D-S01, RF-DS-04). Разбор проверяется на настоящем выводе `tasklist`, CIM и
 * `ps`; файлы `/proc` и разрешение путей подменяются.
 */

const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_LINE = `"${CHROME}" --no-startup-window /prefetch:5`;

const cimLine = (pid: number, session: number | '', name: string, path = '', line = '') =>
  `${pid}\t${session}\t${b64(name)}\t${path ? b64(path) : ''}\t${line ? b64(line) : ''}`;

const CIM = [
  cimLine(0, 0, 'System Idle Process'),
  cimLine(5600, 1, 'explorer.exe'),
  cimLine(15948, 1, 'chrome.exe', CHROME, CHROME_LINE),
  // Командная строка с табуляцией и кириллицей — поэтому поля в base64.
  cimLine(15949, 1, 'chrome.exe', CHROME, `"${CHROME}" "--user-data-dir=C:\\Профили\\a\tb"`),
  cimLine(60, '', 'tailscaled.exe'),
].join('\r\n');

const io = (over: Partial<FactsIo> = {}): FactsIo => ({
  readLink: () => undefined,
  readText: () => undefined,
  realpath: (path) => path,
  ...over,
});

describe('process facts', () => {
  const TASKLIST = [
    '"System Idle Process","0","Services","0","8 КБ"',
    '"svchost.exe","1234","Services","0","12 345 КБ"',
    '"explorer.exe","5600","Console","1","120 000 КБ"',
    '"chrome.exe","15948","Console","1","300 000 КБ"',
  ].join('\r\n');

  it('tasklist: name and session; the Services session is 0; no path', () => {
    const facts = parseTasklist(TASKLIST);
    expect(facts.get(15948)).toEqual({ pid: 15948, name: 'chrome.exe', session: 1 });
    expect(facts.get(1234)?.session).toBe(0);
    expect(facts.size).toBe(4);
  });

  it('CIM: name, session, path and the command line split into words', () => {
    const facts = parseCim(CIM);
    expect(facts.get(15948)).toEqual({
      pid: 15948,
      name: 'chrome.exe',
      session: 1,
      path: CHROME,
      commandLine: CHROME_LINE,
      argv: [CHROME, '--no-startup-window', '/prefetch:5'],
    });
    expect(facts.get(15949)?.argv?.[1]).toBe('--user-data-dir=C:\\Профили\\a\tb');
    expect(facts.get(5600)).toEqual({ pid: 5600, name: 'explorer.exe', session: 1 });
    // Пустой сеанс не превращается в нулевой (нуль — это службы).
    expect(facts.get(60)).toEqual({ pid: 60, name: 'tailscaled.exe' });
    expect(parseCim('garbage\nmore\t1')).toEqual(new Map());
  });

  it('Windows: CIM paths are resolved; an unresolvable path is dropped', async () => {
    const asked: string[] = [];
    const facts = await readProcessFacts(
      'win32',
      async (command) => {
        asked.push(command);
        return CIM;
      },
      // Ярлык, соединение каталогов, имя 8.3 — судится то, куда путь ведёт.
      io({ realpath: (path) => (path === CHROME ? 'D:\\real\\chrome.exe' : undefined) }),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    expect(facts?.get(15948)?.path).toBe('D:\\real\\chrome.exe');
    const dropped = await readProcessFacts(
      'win32',
      async () => CIM,
      io({ realpath: () => undefined }),
    );
    expect(dropped?.get(15948)?.path).toBeUndefined();
    expect(dropped?.get(15948)?.commandLine).toBe(CHROME_LINE);
  });

  it('Windows: a silent WMI falls back to tasklist without paths', async () => {
    const asked: string[] = [];
    const facts = await readProcessFacts(
      'win32',
      async (command) => {
        asked.push(command);
        return command === 'tasklist' ? TASKLIST : undefined;
      },
      io(),
    );
    expect(asked.at(-1)).toBe('tasklist');
    expect(facts?.get(15948)).toEqual({ pid: 15948, name: 'chrome.exe', session: 1 });
  });

  it('the OS saying nothing is undefined, never an empty table', async () => {
    expect(await readProcessFacts('win32', async () => undefined, io())).toBeUndefined();
    expect(await readProcessFacts('linux', async () => undefined, io())).toBeUndefined();
  });

  it('ps with sid: pid, session and uid; comm with a path keeps its last part', () => {
    const facts = parsePs(
      [
        '  701   1  701   501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '  9 1 9 0 tailscaled',
      ].join('\n'),
    );
    expect(facts.get(701)).toEqual({
      pid: 701,
      name: 'Google Chrome',
      session: 701,
      uid: 501,
      path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    expect(facts.get(9)).toEqual({ pid: 9, name: 'tailscaled', session: 9, uid: 0 });
  });

  it('ps without sid (BSD): uid is still read, session stays unknown', () => {
    const facts = parsePs('  701   1   501 chrome\n', false);
    expect(facts.get(701)).toEqual({ pid: 701, name: 'chrome', uid: 501 });
  });

  it('Linux: path from /proc/<pid>/exe and argv from cmdline, only for browser installs', async () => {
    const PS = ['  10 1 10 1000 chrome', '  11 1 11 1000 chrome', '  12 1 12 1000 node'].join('\n');
    const links: Record<string, string> = {
      '/proc/10/exe': '/opt/google/chrome/chrome (deleted)',
      // Переименованная программа вне установки: имя `chrome`, путь чужой.
      '/proc/11/exe': '/home/owner/bin/chrome',
      '/proc/12/exe': '/usr/bin/node',
    };
    const facts = await readProcessFacts(
      'linux',
      async () => PS,
      io({
        readLink: (path) => links[path],
        readText: (path) =>
          path === '/proc/10/cmdline' ? '/opt/google/chrome/chrome\0--enable-automation\0' : 'x',
      }),
    );
    expect(facts?.get(10)).toMatchObject({
      path: '/opt/google/chrome/chrome',
      commandLine: '/opt/google/chrome/chrome --enable-automation',
      argv: ['/opt/google/chrome/chrome', '--enable-automation'],
    });
    expect(facts?.get(11)?.path).toBeUndefined();
    expect(facts?.get(12)?.path).toBeUndefined();
  });

  it('macOS: ps falls back to BSD form; bundle paths resolved; args read for browsers only', async () => {
    const asked: string[][] = [];
    const MAIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const facts = await readProcessFacts(
      'darwin',
      async (_command, args) => {
        asked.push([...args]);
        if (asked.length === 1) return undefined;
        if (args.includes('args=')) return `  701 ${MAIN} --remote-debugging-port=9222\n`;
        return [
          `  701   1   501 ${MAIN}`,
          '  702   1   501 /Users/owner/Desktop/Google Chrome.app/Contents/MacOS/Google Chrome',
          '  703   1   501 /usr/bin/curl',
        ].join('\n');
      },
      io(),
    );
    expect(asked).toHaveLength(3);
    expect(asked[2]).toEqual(['-ww', '-o', 'pid=', '-o', 'args=', '-p', '701']);
    expect(facts?.get(701)).toMatchObject({
      name: 'Google Chrome',
      uid: 501,
      path: MAIN,
      commandLine: `${MAIN} --remote-debugging-port=9222`,
    });
    // Копия связки вне /Applications и обычная программа пути не получают.
    expect(facts?.get(702)?.path).toBeUndefined();
    expect(facts?.get(703)?.path).toBeUndefined();
  });

  it.each(['tailscaled', 'tailscale', 'tailscaled.exe', 'tailscale-ipn.exe'])(
    '%s is the remote proxy',
    (name) => expect(isRemoteProxy(name)).toBe(true),
  );

  it.each(['nginx', 'node', 'sshd'])('%s is not the remote proxy', (name) =>
    expect(isRemoteProxy(name)).toBe(false),
  );
});
