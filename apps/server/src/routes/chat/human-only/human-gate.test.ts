import { describe, expect, it } from 'vitest';
import type { ProcessFact } from '../../../lib/peer-process/process-facts.ts';
import { browserRefusal, isTailnetAddress, localVerdict, remoteVerdict } from './human-gate.ts';
import type { TcpRow } from '../../../lib/peer-process/peer-process.ts';
import { checkHumanCaller, CLIENT_PORT_HEADER } from './human-only.ts';
import {
  CHROME,
  chrome,
  CLI,
  COPY,
  deps,
  DETACHED,
  EDGE_UNDER_CHROME,
  facts,
  gate,
  LAUNCHER,
  MODEL_BROWSER,
  MODEL_NET,
  NET,
  ORPHAN,
  PANEL,
  PW_NET,
  PW_ROOT,
  request,
  ROOT,
  row,
  RUN_ROOT,
  SERVICE,
  TABLE,
  TEMP_NET,
  WIN_ENV,
  WINDOWS,
} from './human-gate.fixture.ts';

/**
 * D-S01 / RF-DS-04 / RF-DS-05: решение человека принимается от трёх звонящих —
 * вызова изнутри панели, браузера человека и прокси Tailscale этой машины.
 * Браузер человека = образ настоящей установки, у корня браузера нет ключей
 * автоматизации, прогона среди предков нет; мёртвый родитель — НЕ отказ (так
 * живёт любой давно открытый браузер). Проверка — на формах, которыми процесс
 * модели проходил прежние правила, и на дереве браузера, которое прежнее
 * правило отбивало.
 */

describe('human gate', () => {
  describe('local verdict (Windows)', () => {
    it('a long-running browser whose parent died is the human (the 69/69 lockout)', () => {
      expect(localVerdict(ROOT, gate())).toBe('human');
      // Сеть держит ребёнок `--type=utility`; ключи судятся у корня.
      expect(localVerdict(NET, gate())).toBe('human');
    });

    it('the panel and the process that started it are no longer trusted', () => {
      expect(localVerdict(PANEL, gate())).toBe('unverified');
      expect(localVerdict(LAUNCHER, gate())).toBe('unverified');
      expect(browserRefusal(PANEL, gate())).toBe('not-a-browser-install');
    });

    it('a process under a run is the model, a browser the run opened too', () => {
      expect(localVerdict(CLI, gate())).toBe('model-process');
      expect(localVerdict(RUN_ROOT, gate())).toBe('model-process');
      expect(localVerdict(MODEL_BROWSER, gate())).toBe('model-process');
      expect(localVerdict(MODEL_NET, gate())).toBe('model-process');
    });

    it('a detached helper without ancestors is not the human', () => {
      expect(localVerdict(DETACHED, gate())).toBe('unverified');
    });

    it('an empty run list passes nobody but the browser', () => {
      expect(localVerdict(DETACHED, gate({ roots: new Set() }))).toBe('unverified');
      expect(localVerdict(NET, gate({ roots: new Set() }))).toBe('human');
    });

    it('a browser driven by automation is refused by the flags of its root', () => {
      expect(browserRefusal(PW_NET, gate())).toBe('enable-automation');
      expect(localVerdict(PW_NET, gate())).toBe('unverified');
      expect(localVerdict(PW_ROOT, gate())).toBe('unverified');
    });

    it('a throwaway profile in temp is refused', () => {
      expect(browserRefusal(TEMP_NET, gate())).toBe('temp-profile');
    });

    it('a copy outside the install, an orphan child, a services-session browser are refused', () => {
      expect(browserRefusal(COPY, gate())).toBe('not-a-browser-install');
      expect(browserRefusal(ORPHAN, gate())).toBe('root-is-a-child');
      expect(browserRefusal(SERVICE, gate())).toBe('service-session');
    });

    it('the root is searched within ONE install: Edge under Chrome is judged by itself', () => {
      expect(browserRefusal(EDGE_UNDER_CHROME, gate())).toBeUndefined();
    });

    it('no path (tasklist fallback) and no command line are refused', () => {
      const bare = facts([{ pid: ROOT, name: 'chrome.exe', session: 1 }]);
      expect(browserRefusal(ROOT, gate({ facts: bare }))).toBe('not-a-browser-install');
      const noLine = facts([{ pid: ROOT, name: 'chrome.exe', session: 1, path: CHROME }]);
      expect(browserRefusal(ROOT, gate({ facts: noLine }))).toBe('no-command-line');
    });

    it('a browser in a per-user root that sits in temp (a throwaway stand) is refused', () => {
      const stand = { ...WIN_ENV, LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local\\Temp\\s\\L' };
      const path =
        'C:\\Users\\owner\\AppData\\Local\\Temp\\s\\L\\Google\\Chrome\\Application\\chrome.exe';
      const local = facts([chrome(ROOT, '', 1, path)]);
      expect(browserRefusal(ROOT, gate({ facts: local, env: stand }))).toBe(
        'not-a-browser-install',
      );
    });
  });

  describe('local verdict (POSIX)', () => {
    const LINUX_CHROME = '/opt/google/chrome/chrome';
    const linuxFact = (pid: number, argv: string[]): ProcessFact => ({
      pid,
      name: 'chrome',
      session: 3000,
      uid: 1000,
      path: LINUX_CHROME,
      commandLine: [LINUX_CHROME, ...argv].join(' '),
      argv: [LINUX_CHROME, ...argv],
    });
    const linuxTable = [
      row(1, 0, 1n),
      row(3000, 2999),
      row(3001, 3000),
      row(3100, 1),
      row(3101, 3100),
    ];
    const linux = (rows: ProcessFact[]) =>
      gate({ table: linuxTable, facts: facts(rows), platform: 'linux', env: {} });

    it('Linux: the zygote child of a plain root is the human; --headless is not', () => {
      const plain = linux([linuxFact(3000, []), linuxFact(3001, ['--type=zygote'])]);
      expect(localVerdict(3001, plain)).toBe('human');
      const headless = linux([
        linuxFact(3000, ['--headless=new']),
        linuxFact(3001, ['--type=zygote']),
      ]);
      expect(browserRefusal(3001, headless)).toBe('headless');
      const tmp = linux([
        linuxFact(3100, ['--user-data-dir=/tmp/pw']),
        linuxFact(3101, ['--type=gpu-process']),
      ]);
      expect(browserRefusal(3101, tmp)).toBe('temp-profile');
    });

    it('Linux: a renamed program named chrome outside the install is refused', () => {
      const renamed = linux([{ ...linuxFact(3000, []), path: '/home/owner/chrome' }]);
      expect(browserRefusal(3000, renamed)).toBe('not-a-browser-install');
    });

    it('macOS: the helper holding the socket is judged by the main program of its bundle', () => {
      const MAIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      const HELPER =
        '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/130/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper';
      const mac = (mainArgs: string) =>
        gate({
          table: [row(1, 0, 1n), row(600, 1), row(601, 600)],
          platform: 'darwin',
          env: {},
          facts: facts([
            {
              pid: 600,
              name: 'Google Chrome',
              uid: 501,
              path: MAIN,
              commandLine: `${MAIN}${mainArgs}`,
              argv: [MAIN],
            },
            {
              pid: 601,
              name: 'Google Chrome Helper',
              uid: 501,
              path: HELPER,
              commandLine: `${HELPER} --type=utility`,
              argv: [HELPER, '--type=utility'],
            },
          ]),
        });
      expect(localVerdict(601, mac(''))).toBe('human');
      expect(browserRefusal(601, mac(' --remote-debugging-port=9222'))).toBe(
        'remote-debugging-port',
      );
      // Помощник без главного (тот вышел) — судить запуск не по чему.
      const orphan = { ...mac(''), table: [row(601, 9999)] };
      expect(browserRefusal(601, orphan)).toBe('root-is-a-child');
    });
  });

  describe('remote verdict', () => {
    const remote = (proxy: ProcessFact, platform = 'win32') =>
      gate({
        platform,
        facts: facts([...WINDOWS.values(), proxy]),
        table: [...TABLE, row(60, 1)],
      });
    const ok = { hop: '100.101.1.2', bearer: true };

    it('the tailnet proxy service of this machine with a token is the human', () => {
      expect(remoteVerdict(60, remote({ pid: 60, name: 'tailscaled.exe', session: 0 }), ok)).toBe(
        'human',
      );
      expect(
        remoteVerdict(
          60,
          remote({ pid: 60, name: 'tailscaled', uid: 0, session: 60 }, 'linux'),
          ok,
        ),
      ).toBe('human');
    });

    it('the name alone or the service alone is not the proxy (RF-DS-05)', () => {
      // Своя программа с именем прокси в сеансе пользователя.
      expect(remoteVerdict(60, remote({ pid: 60, name: 'tailscaled.exe', session: 1 }), ok)).toBe(
        'unverified',
      );
      // Любая служба.
      expect(remoteVerdict(60, remote({ pid: 60, name: 'svchost.exe', session: 0 }), ok)).toBe(
        'unverified',
      );
      expect(
        remoteVerdict(
          60,
          remote({ pid: 60, name: 'tailscaled', uid: 1000, session: 60 }, 'linux'),
          ok,
        ),
      ).toBe('unverified');
    });

    it('a token without a tailnet address, or a tailnet address without a token, is refused', () => {
      const proxy = remote({ pid: 60, name: 'tailscaled.exe', session: 0 });
      expect(remoteVerdict(60, proxy, { hop: '203.0.113.5', bearer: true })).toBe('unverified');
      expect(remoteVerdict(60, proxy, { hop: '100.101.1.2', bearer: false })).toBe('unverified');
    });

    it('a run process behind the proxy stays the model', () => {
      expect(remoteVerdict(CLI, gate(), ok)).toBe('model-process');
    });
  });

  it.each([
    ['100.64.0.1', true],
    ['100.127.255.254', true],
    ['100.101.5.7', true],
    ['100.63.0.1', false],
    ['100.128.0.1', false],
    ['192.168.1.5', false],
    ['fd7a:115c:a1e0::1', true],
    ['fd00::1', false],
  ])('tailnet address %s → %s', (value, expected) => {
    expect(isTailnetAddress(value)).toBe(expected);
  });
});

describe('checkHumanCaller', () => {
  it('strict: the browser of the human passes', async () => {
    expect(await checkHumanCaller(request(), deps(NET))).toEqual({ ok: true });
  });

  it('strict: the panel calling itself over a socket is refused (RF-DS-05)', async () => {
    expect(await checkHumanCaller(request(), deps(PANEL))).toEqual({
      ok: false,
      reason: 'device-unverified',
    });
  });

  it('strict: an unrecognised caller and a driven browser are device-unverified', async () => {
    for (const owner of [DETACHED, PW_NET, COPY]) {
      expect(await checkHumanCaller(request(), deps(owner))).toEqual({
        ok: false,
        reason: 'device-unverified',
      });
    }
  });

  it('strict: a process under a run is refused as the model', async () => {
    for (const owner of [CLI, MODEL_NET]) {
      expect(await checkHumanCaller(request(), deps(owner))).toEqual({
        ok: false,
        reason: 'model-process',
      });
    }
  });

  it('strict: no sockets at all is the in-process call (app.inject)', async () => {
    const inProcess = { headers: {}, socket: {} as never };
    expect(await checkHumanCaller(inProcess, deps(NET))).toEqual({ ok: true });
  });

  it('strict: the OS staying silent is 503 peer-unknown, never a pass', async () => {
    const silent = { ...deps(NET), readFacts: async () => undefined };
    expect(await checkHumanCaller(request(), silent)).toEqual({
      ok: false,
      reason: 'peer-unknown',
    });
    const noTable = { ...deps(NET), readTable: async () => undefined };
    expect(await checkHumanCaller(request(), noTable)).toEqual({
      ok: false,
      reason: 'peer-unknown',
    });
    const noOwner = deps(NET, { rows: [] });
    expect(await checkHumanCaller(request(), noOwner)).toEqual({
      ok: false,
      reason: 'peer-unknown',
    });
  });

  it('a recognised browser is cached by pid and creation time; facts are read once', async () => {
    const known = new Set<string>();
    const first = deps(NET, { known });
    expect(await checkHumanCaller(request(), first)).toEqual({ ok: true });
    expect(await checkHumanCaller(request(), first)).toEqual({ ok: true });
    expect(first.counter.facts).toBe(1);
    expect([...known]).toEqual([`${NET}:${NET}`]);
    // Тот же номер у другого процесса (другое время создания) судится заново.
    const reused = { ...deps(DETACHED, { known: new Set([`${DETACHED}:1`]) }) };
    expect(await checkHumanCaller(request(), reused)).toEqual({
      ok: false,
      reason: 'device-unverified',
    });
    expect(reused.counter.facts).toBe(1);
  });

  it('a cached browser is still checked for a run among its ancestors', async () => {
    const known = new Set([`${MODEL_NET}:${MODEL_NET}`]);
    const cached = deps(MODEL_NET, { known });
    expect(await checkHumanCaller(request(), cached)).toEqual({
      ok: false,
      reason: 'model-process',
    });
  });

  it('strict: the Vite hop is believed only when that neighbour accepted it', async () => {
    const rows: TcpRow[] = [
      { localPort: 61_001, remotePort: 5178, pid: 61 },
      { localPort: 8888, remotePort: 61_050, pid: 61 },
      { localPort: 61_050, remotePort: 8888, pid: NET },
    ];
    const headers = { [CLIENT_PORT_HEADER]: '61050' };
    const through = {
      ...deps(61, { rows }),
      readTable: async () => [...TABLE, row(61, LAUNCHER)],
    };
    expect(await checkHumanCaller(request({ headers }), through)).toEqual({ ok: true });
    // Тот же заголовок от процесса модели: судится он сам.
    const forged: TcpRow[] = [
      { localPort: 61_001, remotePort: 5178, pid: CLI },
      { localPort: 61_050, remotePort: 8888, pid: NET },
    ];
    expect(await checkHumanCaller(request({ headers }), deps(CLI, { rows: forged }))).toEqual({
      ok: false,
      reason: 'model-process',
    });
  });

  it('strict: X-Forwarded-For with this machine own address is refused', async () => {
    const headers = { 'x-forwarded-for': '100.101.9.9', authorization: 'Bearer x' };
    expect(await checkHumanCaller(request({ headers }), deps(NET))).toEqual({
      ok: false,
      reason: 'same-machine-remote',
    });
  });

  it('strict: a remote answer from the browser, not the proxy, is remote-unverified and never cached', async () => {
    const headers = { 'x-forwarded-for': '100.101.1.2', authorization: 'Bearer x' };
    const known = new Set([`${NET}:${NET}`]);
    expect(await checkHumanCaller(request({ headers }), deps(NET, { known }))).toEqual({
      ok: false,
      reason: 'remote-unverified',
    });
  });

  it('lenient: an unrecognised reader sees the list, a run process does not', async () => {
    expect(await checkHumanCaller(request(), deps(DETACHED), 'lenient')).toEqual({ ok: true });
    expect(await checkHumanCaller(request(), deps(CLI), 'lenient')).toEqual({
      ok: false,
      reason: 'model-process',
    });
  });

  it('lenient: with no runs at all the OS tables are not read', async () => {
    let read = 0;
    const quiet = {
      ...deps(DETACHED),
      roots: () => [],
      readTcp: async () => {
        read += 1;
        return [];
      },
    };
    expect(await checkHumanCaller(request(), quiet, 'lenient')).toEqual({ ok: true });
    expect(read).toBe(0);
  });
});
