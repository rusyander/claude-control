import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchDetached, wmiCreateScript } from './detached-launch.ts';
import { encodePowerShell, psQuote } from './hidden-launch.ts';
import { launchKept } from './kept-launch.ts';
import { hasValue } from './os-kind.ts';
import { createLivenessProbe } from './process-identity.ts';
import type { ProcessIdentity } from './process-table.ts';
import { quoteWindowsArg, spawnTracked } from './spawn.ts';
import { stopTree } from './tree-stop.ts';
import { TREE_SCRIPT, waitFor } from './__fixtures__/harness.ts';

const isWin = process.platform === 'win32';
const NASTY = [
  'plain',
  'with space',
  'quote "inner" end',
  "single 'q'",
  'line1\nline2',
  '%PATH%',
  '$HOME $(Get-Date)',
  'trailing back\\',
  '',
  'кириллица ü',
  // F-17: типографские апострофы PowerShell считает одинарной кавычкой — строка не должна закрыться.
  'a’ + $env:USERNAME + ’b',
  '‘x’ ‚y‛',
];

let dir = '';
const leftovers: ProcessIdentity[] = [];

function env(extra: Record<string, string> = {}): Record<string, string> {
  const keep = isWin ? ['SystemRoot', 'TEMP', 'TMP', 'WINDIR'] : ['HOME', 'TMPDIR'];
  const out: Record<string, string> = {};
  for (const key of keep) if (process.env[key] !== undefined) out[key] = process.env[key] ?? '';
  out.PATH = dirname(process.execPath);
  return { ...out, ...extra };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hidden launch ü '));
});
afterAll(async () => {
  for (const id of leftovers) await stopTree(id, { graceMs: 500 });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('P54 hidden-console launch — script quoting', () => {
  it("P54 PowerShell quoting: every single-quote codepoint (`'`, U+2018–U+201B) doubled; every argv element CommandLineToArgvW-quoted inside", () => {
    expect(psQuote("it's")).toBe("'it''s'");
    // F-17: каждый символ класса одинарной кавычки PowerShell (U+0027, U+2018–U+201B) удваивается.
    expect(psQuote('a’b‘c‚d‛e')).toBe("'a’’b‘‘c‚‚d‛‛e'");
    // Командная строка WMI: каждый элемент argv — по правилам CommandLineToArgvW, вся строка —
    // в одинарных кавычках PowerShell внутри скрипта, скрипт — `-EncodedCommand`.
    const commandLine = ['C:\\a b\\srv.exe', 'x y', 'q"z']
      .map((part) => quoteWindowsArg(part))
      .join(' ');
    expect(commandLine).toBe('"C:\\a b\\srv.exe" "x y" "q\\"z"');
    const script = wmiCreateScript(commandLine, 'C:\\w’');
    expect(script).toContain(`CommandLine = '"C:\\a b\\srv.exe" "x y" "q\\"z"'`);
    expect(script).toContain("CurrentDirectory = 'C:\\w’’'");
    expect(Buffer.from(encodePowerShell(script), 'base64').toString('utf16le')).toBe(script);
  });

  it.runIf(isWin)(
    'P54 Windows WMI launch (the server way): argv intact at the started process',
    async () => {
      const out = join(dir, 'argv.json');
      const outcome = await launchDetached({
        file: process.execPath,
        args: [
          '-e',
          "require('fs').writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))",
          out,
          ...NASTY,
        ],
        cwd: dir,
        env: env(),
        breakaway: true,
      });
      if (!outcome.ok) throw new Error(outcome.reason);
      expect(outcome.via).toBe('wmi');
      const text = await waitFor(
        () => {
          const body = existsSync(out) ? readFileSync(out, 'utf8') : '';
          return body.endsWith('}') ? body : undefined;
        },
        20_000,
        'argv dump',
      );
      const dump = JSON.parse(text) as { argv: string[]; cwd: string };
      expect(dump.argv).toEqual(NASTY);
      expect(dump.cwd.toLowerCase()).toBe(dir.toLowerCase());
    },
  );
});

describe('kept launch resolves an explicit relative command against the target cwd', () => {
  // node ядра путём от каталога ядра: от cwd цели (глубже в temp) этот путь ведёт в никуда —
  // проверка до хранителя обязана сказать «не найден», а не запустить найденное от ядра.
  const rel = relative(process.cwd(), process.execPath);
  it.runIf(!isAbsolute(rel))(
    'a path valid only from the core process cwd → refused before the keeper starts',
    async () => {
      // Цель глубже, чем `..` в пути: иначе подъём упирается в корень и путь снова настоящий
      // (Linux-контейнер: cwd /work/apps/core, `../../../usr/local/bin/node` из /tmp/x — тот же node).
      const ups = rel.split(/[\\/]/).filter((s) => s === '..').length;
      const target = join(
        mkdtempSync(join(dir, 'kept-cwd-')),
        ...Array.from({ length: ups }, (_, i) => `d${i}`),
      );
      mkdirSync(target, { recursive: true });
      const outcome = await launchKept({
        command: rel,
        args: ['-e', 'process.exit(0)'],
        cwd: target,
        env: env(),
        stateDir: target,
      });
      // Отказ до хранителя: без pid и без «refused:» самого хранителя.
      expect(outcome).toEqual({ ok: false, reason: expect.stringMatching(/^«.*» not found/) });
    },
  );
});

describe('P113 model-server runner children — tree stop catches them', () => {
  it('P113 a server launched the server way with two runner children → tree stop leaves none alive', async () => {
    const state = mkdtempSync(join(dir, 'srv-'));
    // Раннеры отвязаны (`*`): обычный ребёнок node на Windows сидит в задании libuv с
    // KILL_ON_JOB_CLOSE и умирает вместе с сервером сам — так свойство было бы верно без
    // обхода дерева. Сервер модели не на node таких заданий не заводит; на POSIX отвязанный
    // раннер в своей сессии, групповой сигнал корня до него не доходит.
    const plan = { TREE_PLAN: 'server>runner1*,server>runner2*' };
    let root: ProcessIdentity;
    if (isWin) {
      // Сервер модели на Windows идёт хранителем (`launchKept`): корень дерева — хранитель,
      // сервер — его ребёнок, раннеры — внуки.
      const outcome = await launchKept({
        command: process.execPath,
        args: [TREE_SCRIPT, state, 'server'],
        cwd: state,
        env: env(plan),
        stateDir: state,
      });
      if (!outcome.ok) throw new Error(JSON.stringify(outcome));
      root = outcome.identity;
    } else {
      const outcome = await spawnTracked({
        command: process.execPath,
        args: [TREE_SCRIPT, state, 'server'],
        cwd: state,
        env: env(plan),
        detached: true,
        stdio: 'ignore',
      });
      if (!outcome.ok || !outcome.identity || !hasValue(outcome.identity))
        throw new Error('no identity');
      outcome.child.unref();
      root = outcome.identity.value;
    }
    leftovers.push(root);
    const pids = await waitFor(
      () => {
        const read = (role: string) =>
          existsSync(join(state, `${role}.pid`))
            ? Number(readFileSync(join(state, `${role}.pid`), 'utf8'))
            : 0;
        const all = ['server', 'runner1', 'runner2'].map(read);
        return all.every((pid) => pid > 0) ? all : undefined;
      },
      20_000,
      'runner pids',
    );
    // POSIX: сервер сам корень своей группы; Windows: корень — хранитель, сервер — его ребёнок.
    if (!isWin) expect(pids[0]).toBe(root.pid);
    const probe = createLivenessProbe(undefined, 0);
    const runners: ProcessIdentity[] = [];
    for (const pid of pids.slice(1)) {
      const id = await probe.identityOf(pid);
      if (!hasValue(id)) throw new Error(`runner ${pid}: no identity`);
      runners.push(id.value);
    }
    const report = await stopTree(root, { graceMs: 1_000, group: !isWin });
    expect(report.residual).toEqual([]);
    for (const id of [root, ...runners]) expect(await probe.isAlive(id)).toBe('dead');
    writeFileSync(join(state, 'server.exit'), '');
  });
});
