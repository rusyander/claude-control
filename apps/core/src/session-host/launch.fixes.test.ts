import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchSession, preparePrivateDir, privateChannelDir } from './launch.ts';
import { sessionFile, type Identity } from './protocol.ts';
import { TREE_MARKER } from './host.ts';
import { attachSession } from './client.ts';
import { helperEnv, launchDetached, type DetachedSpec } from '../platform/detached-launch.ts';
import { createLivenessProbe, identityOfPid } from '../platform/process-identity.ts';
import { stopTree } from '../platform/tree-stop.ts';
import { hasValue } from '../platform/os-kind.ts';

/**
 * core-s2 запуск хоста сессии: F-56 (хост вне задания ядра на Windows, запасной путь без WMI),
 * F-99 (не дождались хоста — хост и дерево CLI сняты), F-100 (чужие исходы прошлого хоста в
 * том же каталоге не выдаются за свои; живой хост каталога не затирается), F-60 (сокет POSIX
 * в личном каталоге 0700, а не в общем `/tmp`).
 */

const CLI = fileURLToPath(new URL('./__fixtures__/numbered-cli.mjs', import.meta.url));
let root = '';
const stopLater: Identity[] = [];
const probe = () => createLivenessProbe(undefined, 0);

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    ),
    ...extra,
  };
}

function base(dir: string, over: Record<string, unknown> = {}) {
  return {
    dir,
    sessionId: `fx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    command: process.execPath,
    args: [CLI],
    cwd: dir,
    env: cliEnv({ COUNT: '3', PACE_MS: '20' }),
    ...over,
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'launch-fixes-'));
});
afterAll(async () => {
  await Promise.all(stopLater.map((id) => stopTree(id, { graceMs: 500 })));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}, 90_000);

describe('core-s2 session launch — host outside the core job (F-56)', () => {
  it('F-56 Windows: the host goes through WMI by default; WMI refused → a plain detached host, the session still starts', async () => {
    const dir = mkdtempSync(join(root, 'f56-'));
    const handed: DetachedSpec[] = [];
    const launched = await launchSession(base(dir), {
      launch: (spec) => {
        handed.push(spec);
        if (spec.breakaway) return Promise.resolve({ ok: false, reason: 'wmi refused: 2' });
        return launchDetached(spec);
      },
    });
    if (!launched.ok) throw new Error(launched.reason);
    stopLater.push(launched.child, launched.host);
    if (process.platform === 'win32') {
      expect(handed.map((s) => s.breakaway === true)).toEqual([true, false]);
    } else {
      expect(handed.map((s) => s.breakaway === true)).toEqual([false]);
    }
    const attached = await attachSession(dir);
    if (attached.state === 'live') {
      attached.session.end();
      attached.session.close();
    }
  }, 60_000);

  it('the host runs from the volume root, never from the session dir its conhost would hold after it exits', async () => {
    const dir = mkdtempSync(join(root, 'cwd-'));
    const handed: DetachedSpec[] = [];
    const launched = await launchSession(base(dir), {
      launch: (spec) => {
        handed.push(spec);
        return launchDetached(spec);
      },
    });
    if (!launched.ok) throw new Error(launched.reason);
    stopLater.push(launched.child, launched.host);
    expect(handed.length).toBeGreaterThan(0);
    expect(handed.map((s) => s.cwd)).toEqual(handed.map(() => parse(dir).root));
    const attached = await attachSession(dir);
    if (attached.state === 'live') {
      attached.session.end();
      attached.session.close();
    }
  }, 60_000);

  it('F-56 an explicit breakaway the platform refuses is not silently downgraded', async () => {
    const dir = mkdtempSync(join(root, 'f56x-'));
    const handed: DetachedSpec[] = [];
    const launched = await launchSession(base(dir, { breakaway: true }), {
      launch: (spec) => {
        handed.push(spec);
        return Promise.resolve({ ok: false, reason: 'wmi refused: 2' });
      },
    });
    expect(launched).toMatchObject({ ok: false });
    expect(launched.ok ? '' : launched.reason).toMatch(/wmi refused/);
    expect(handed).toHaveLength(1);
  });
});

describe('core-s2 session launch — host not ready in time (F-99)', () => {
  it('F-99 the started host and the CLI it re-parented away are stopped when the host never reports ready', async () => {
    const dir = mkdtempSync(join(root, 'f99-'));
    const gcFile = join(dir, 'grandchild.pid');
    // Поддельный хост: запускает посредника, тот — внука с меткой дерева и уходит (внук
    // «переродился» и в дерево хоста не входит); сам хост не пишет host.json никогда.
    const mid = join(dir, 'mid.cjs');
    writeFileSync(
      mid,
      [
        "const { spawn } = require('node:child_process');",
        "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true, windowsHide: true });",
        "require('node:fs').writeFileSync(process.env.GC_FILE, String(g.pid));",
        'g.unref();',
        'process.exit(0);',
      ].join('\n'),
    );
    const fakeHost = join(dir, 'host.cjs');
    writeFileSync(
      fakeHost,
      [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, [${JSON.stringify(mid)}], { stdio: 'ignore', detached: true, windowsHide: true, env: { ...process.env, ${TREE_MARKER}: process.env.SID, GC_FILE: process.env.GC_FILE } }).unref();`,
        'setTimeout(() => {}, 60000);',
      ].join('\n'),
    );
    const spec = base(dir, { readyTimeoutMs: 4_000 });
    let hostPid = 0;
    const launched = await launchSession(spec, {
      launch: async () => {
        const started = await launchDetached({
          file: process.execPath,
          args: [fakeHost],
          cwd: dir,
          env: { ...helperEnv(), SID: spec.sessionId, GC_FILE: gcFile },
        });
        if (started.ok) hostPid = started.pid;
        return started;
      },
    });
    expect(launched).toMatchObject({ ok: false, reason: 'host not ready in time' });
    const host = await identityOfPid(hostPid);
    const gcPid = existsSync(gcFile) ? Number(readFileSync(gcFile, 'utf8')) : 0;
    const grandchild = gcPid ? await identityOfPid(gcPid) : undefined;
    // Хост и внук — уже мёртвые: личности не читаются, либо читаются и мертвы.
    for (const [name, id] of [
      ['host', host],
      ['grandchild', grandchild],
    ] as const) {
      if (id && hasValue(id)) {
        stopLater.push(id.value);
        expect(await probe().isAlive(id.value), name).toBe('dead');
      }
    }
    expect(gcPid).toBeGreaterThan(0);
  }, 60_000);
});

describe('core-s2 session launch — a reused session dir (F-100)', () => {
  it('F-100 stale host.json / exit.json / host.err of a dead host are cleared; the new host is the one reported', async () => {
    const dir = mkdtempSync(join(root, 'f100-'));
    writeFileSync(
      sessionFile(dir, 'host'),
      JSON.stringify({
        v: 1,
        host: { pid: 999_991, start: 'stale-start' },
        child: { pid: 999_992, start: 'stale' },
        channel: 'x',
        startedAt: 1,
      }),
    );
    writeFileSync(
      sessionFile(dir, 'exit'),
      JSON.stringify({ code: null, signal: null, stopped: false, refused: 'old refusal' }),
    );
    writeFileSync(sessionFile(dir, 'hostErr'), 'old crash\n');
    let started = 0;
    const launched = await launchSession(base(dir), {
      launch: async (spec) => {
        const out = await launchDetached(spec);
        if (out.ok) started = out.pid;
        return out;
      },
    });
    if (!launched.ok) throw new Error(launched.reason);
    stopLater.push(launched.child, launched.host);
    expect(launched.host.pid).toBe(started);
    const attached = await attachSession(dir);
    if (attached.state === 'live') {
      attached.session.end();
      attached.session.close();
    }
  }, 60_000);

  it('F-100 a session dir whose host.json names a live host is refused before anything is written or started', async () => {
    const dir = mkdtempSync(join(root, 'f100live-'));
    const self = await identityOfPid(process.pid);
    if (!hasValue(self)) throw new Error('own identity unreadable');
    writeFileSync(
      sessionFile(dir, 'host'),
      JSON.stringify({ v: 1, host: self.value, child: null, channel: 'x', startedAt: 1 }),
    );
    writeFileSync(sessionFile(dir, 'token'), 'live-host-token');
    const handed: DetachedSpec[] = [];
    const launched = await launchSession(base(dir), {
      launch: (spec) => {
        handed.push(spec);
        return Promise.resolve({ ok: false, reason: 'must not start' });
      },
    });
    expect(launched).toMatchObject({ ok: false, refused: true });
    expect(launched.ok ? '' : launched.reason).toMatch(/live host/);
    expect(handed).toHaveLength(0);
    expect(readFileSync(sessionFile(dir, 'token'), 'utf8')).toBe('live-host-token');
  });

  it('F-100 an exit.json that is present but unreadable while polling is waited out, not read as «no refusal»', async () => {
    const dir = mkdtempSync(join(root, 'f100poll-'));
    const sleeper = await launchDetached({
      file: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: dir,
      env: helperEnv(),
    });
    if (!sleeper.ok) throw new Error(sleeper.reason);
    const sleeperId = await identityOfPid(sleeper.pid);
    if (hasValue(sleeperId)) stopLater.push(sleeperId.value);
    const launched = await launchSession(base(dir, { readyTimeoutMs: 10_000 }), {
      launch: async () => {
        writeFileSync(sessionFile(dir, 'exit'), '{"code":nu');
        writeFileSync(
          sessionFile(dir, 'host'),
          JSON.stringify({
            v: 1,
            host: { pid: sleeper.pid, start: 's' },
            child: null,
            channel: 'x',
            startedAt: 1,
          }),
        );
        setTimeout(
          () =>
            writeFileSync(
              sessionFile(dir, 'exit'),
              JSON.stringify({ code: null, signal: null, stopped: false, refused: 'late refusal' }),
            ),
          300,
        );
        return { ok: true, pid: sleeper.pid, via: 'spawn' };
      },
    });
    expect(launched).toMatchObject({ ok: false, reason: 'late refusal', refused: true });
  }, 30_000);
});

describe('core-s2 session launch — POSIX control socket in a private dir (F-60)', () => {
  const ok = (): null => null;

  it('F-60 candidates in order: $XDG_RUNTIME_DIR/agentdeck, <tmp>/agentdeck-<uid>, /tmp/agentdeck-<uid>; a failing one is skipped', () => {
    const asked: string[] = [];
    const record = (fail: Set<string>) => (path: string) => {
      asked.push(path);
      return fail.has(path) ? 'owned by uid 0' : null;
    };
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
    expect(
      privateChannelDir({ os: 'linux', env, temp: '/var/tmp', uid: 1000, prepare: ok }),
    ).toEqual({ value: '/run/user/1000/agentdeck' });
    expect(
      privateChannelDir({
        os: 'linux',
        env,
        temp: '/var/tmp',
        uid: 1000,
        prepare: record(new Set(['/run/user/1000/agentdeck'])),
      }),
    ).toEqual({ value: '/var/tmp/agentdeck-1000' });
    expect(asked).toEqual(['/run/user/1000/agentdeck', '/var/tmp/agentdeck-1000']);
    expect(
      privateChannelDir({ os: 'darwin', env: {}, temp: '/var/folders/x/T', uid: 501, prepare: ok }),
    ).toEqual({ value: '/var/folders/x/T/agentdeck-501' });
  });

  it('F-60 a relative XDG dir and a temp too deep for sun_path are skipped; nothing private → a reason, never shared /tmp', () => {
    const deep = `/home/${'d'.repeat(80)}`;
    expect(
      privateChannelDir({
        os: 'linux',
        env: { XDG_RUNTIME_DIR: 'run/rel' },
        temp: deep,
        uid: 7,
        prepare: ok,
      }),
    ).toEqual({ value: '/tmp/agentdeck-7' });
    const none = privateChannelDir({
      os: 'linux',
      env: {},
      temp: '/tmp',
      uid: 7,
      prepare: () => 'not a directory',
    });
    expect(none).toMatchObject({ unknown: expect.stringMatching(/no private socket dir/) });
    // Без uid (Windows) личный каталог не проверить — причина, а не общий каталог.
    if (process.getuid === undefined) {
      expect(privateChannelDir({ os: 'linux', env: {}, temp: '/tmp', prepare: ok })).toMatchObject({
        unknown: expect.stringMatching(/uid/),
      });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'F-60 POSIX: own dir opened to the world is closed to 0700; a symlink in its place is refused',
    () => {
      const uid = process.getuid?.() ?? -1;
      const open = join(root, 'open-dir');
      mkdirSync(open);
      // umask срезал бы права при создании — открываем явно.
      chmodSync(open, 0o777);
      expect(preparePrivateDir(open, uid)).toBeNull();
      expect(lstatSync(open).mode & 0o777).toBe(0o700);
      const target = join(root, 'target-dir');
      mkdirSync(target, { mode: 0o700 });
      const link = join(root, 'link-dir');
      symlinkSync(target, link);
      expect(preparePrivateDir(link, uid)).toMatch(/symlink|not a directory/);
      expect(preparePrivateDir(open, uid + 1)).toMatch(/owned by uid/);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'F-60 POSIX: the launched host listens in a 0700 dir owned by this user',
    async () => {
      const dir = mkdtempSync(join(root, 'f60-'));
      const launched = await launchSession(base(dir));
      if (!launched.ok) throw new Error(launched.reason);
      stopLater.push(launched.child, launched.host);
      const parent = lstatSync(dirname(launched.channel));
      expect(parent.isDirectory()).toBe(true);
      expect(parent.mode & 0o777).toBe(0o700);
      expect(parent.uid).toBe(process.getuid?.());
      const attached = await attachSession(dir);
      if (attached.state === 'live') {
        attached.session.end();
        attached.session.close();
      }
    },
    60_000,
  );
});
