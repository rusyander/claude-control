import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installLedger } from './verify-ledger.ts';

/**
 * Журнал проверок (`tools/verify-ledger/`) живыми процессами node с настоящим
 * `--require` и настоящим git: каждый тест — одноразовый репозиторий и
 * поддельная проверка проекта, которая печатает итог и выходит с заданным кодом.
 * Номера T — из `.agent/tmp/verify-ledger-tests.agent.md`; у каждого названа
 * наивная реализация, на которой тест обязан покраснеть.
 */
const DIR = resolve(__dirname, '../../../../../tools/verify-ledger');
const PRELOAD = join(DIR, 'preload.cjs').replace(/\\/g, '/');
const load = createRequire(__filename);
const ledger = load(join(DIR, 'ledger.cjs')) as {
  repoOf: (cwd: string) => { top: string; store: string; index: string; off?: string };
  records: (repo: object, key: string) => Array<{ exit: number; runId: string }>;
  decide: (repo: object, key: string, o?: object) => { hit: unknown; reason: string };
  writeRecord: (repo: object, r: object, out: object, art?: object[]) => { runId: string };
};
const { recognize } = load(join(DIR, 'checks.cjs')) as {
  recognize: (argv: string[], cwd: string) => { id: string; noSkip: string | null } | null;
};

let root: string;
let repo: string;
let home: string;

/**
 * Поддельная проверка: печать, необязательная пауза и правка дерева посреди прогона.
 * Управление — окружением (оно в ключе) или файлом вне репозитория `FAKE_CTL` (вне ключа:
 * тот же ключ, другой исход — так тест получает «код поменялся, а журнал не видит»).
 */
const CHECK = `
import fs from 'node:fs';
import { helper } from './helper.mjs';
const ctl = process.env.FAKE_CTL && fs.existsSync(process.env.FAKE_CTL) ? JSON.parse(fs.readFileSync(process.env.FAKE_CTL, 'utf8')) : {};
const e = { ...process.env, ...ctl };
console.log('Test Files  3 passed ' + helper());
console.error('note on stderr');
if (e.FAKE_INHERIT) (await import('node:child_process')).spawnSync(process.execPath, ['-e', 'console.log(1)'], { stdio: 'inherit' });
if (e.FAKE_ESBUILD) (await import('node:child_process')).spawnSync('node_modules/@esbuild/win32-x64/esbuild.exe', ['--version'], { stdio: ['pipe', 'pipe', 'inherit'] });
if (e.FAKE_BIG) process.stdout.write('x'.repeat(Number(e.FAKE_BIG)));
if (e.FAKE_EDIT) { fs.writeFileSync('src.txt', 'B\\n'); if (e.FAKE_REVERT) { await new Promise((r) => setTimeout(r, 30)); fs.writeFileSync('src.txt', 'A\\n'); } }
if (e.FAKE_STAMP) fs.writeFileSync(e.FAKE_STAMP, 'stamp-' + fs.readFileSync('src.txt', 'utf8'));
if (e.FAKE_SLEEP) await new Promise((r) => setTimeout(r, Number(e.FAKE_SLEEP)));
process.exitCode = Number(e.FAKE_EXIT || 0);
`;

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function registry(extra: object = {}) {
  writeFileSync(
    join(repo, '.claude/tools/verify-checks.json'),
    JSON.stringify({ checks: [{ id: 'fake', script: '.claude/tools/check.mjs', ...extra }] }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-ledger-'));
  repo = join(root, 'repo');
  home = join(root, 'home');
  // Прямые вызовы библиотеки (T12, T19) берут ключ подписи из окружения этого процесса.
  process.env.AGENTDECK_VERIFY_LEDGER_HOME = home;
  mkdirSync(join(repo, '.claude/tools'), { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, '.gitattributes'), '* text=auto eol=lf\n');
  writeFileSync(join(repo, '.gitignore'), '.claude/\n.env*\nnode_modules/\n');
  writeFileSync(join(repo, 'src.txt'), 'A\n');
  writeFileSync(join(repo, '.claude/tools/check.mjs'), CHECK);
  writeFileSync(join(repo, '.claude/tools/helper.mjs'), 'export const helper = () => "v1";\n');
  registry();
  git('add', '-A');
  git('commit', '-qm', 'init');
});
afterEach(() => {
  delete process.env.AGENTDECK_VERIFY_LEDGER_HOME;
  rmSync(root, { recursive: true, force: true });
});

type Run = { code: number | null; out: string; err: string };

// TZ и CI входят в ключ (T5): унаследованные от раннера (`CI=1` в контейнере) совпали
// бы со значением теста, и «промах» стал бы повтором.
const { TZ: _tz, CI: _ci, ...baseEnv } = process.env;

function run(env: Record<string, string> = {}, args: string[] = []): Run {
  const r = spawnSync(process.execPath, ['.claude/tools/check.mjs', ...args], {
    cwd: repo,
    encoding: 'utf8',
    // Предел spawnSync по умолчанию — 1 МБ: больший вывод (T15) убивал бы ребёнка,
    // и «записи нет» доказывало бы убийство, а не предел захвата журнала.
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...baseEnv,
      NODE_OPTIONS: `--require "${PRELOAD}"`,
      AGENTDECK_VERIFY_LEDGER_HOME: home,
      AGENTDECK_VERIFY_LEDGER: 'on',
      // Прогон под панелью приносит её замок — тест сам решает, есть ли он.
      AGENTDECK_VERIFY_LEDGER_LOCK: '',
      FAKE_CTL: join(root, 'ctl.json'),
      ...env,
    },
    timeout: 30_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
/** Исход следующих прогонов — мимо ключа (файл вне репозитория). */
const outside = (vars: Record<string, string>) =>
  writeFileSync(join(root, 'ctl.json'), JSON.stringify(vars));

const reused = (r: Run) => r.err.includes('[verify-ledger] reused green');
const events = () =>
  existsSync(join(home, 'events.jsonl'))
    ? readFileSync(join(home, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { kind: string; reason?: string; mode?: string })
    : [];
const storeOf = () => ledger.repoOf(repo);
const recordCount = () => {
  const dir = join(storeOf().store, 'v1', 'runs');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).reduce((n, d) => n + readdirSync(join(dir, d)).length, 0);
};

describe('verify-ledger: повтор при том же содержимом', () => {
  it('второй прогон того же дерева — повтор с тем же выводом и кодом', () => {
    const first = run();
    expect(first.code).toBe(0);
    expect(reused(first)).toBe(false);
    const second = run();
    expect(reused(second)).toBe(true);
    expect(second.code).toBe(0);
    expect(second.out).toBe(first.out);
    expect(second.err.startsWith(first.err)).toBe(true);
  });

  it('T21: коммит и amend без правок содержимого — повтор (ключ не sha)', () => {
    writeFileSync(join(repo, 'src.txt'), 'C\n');
    run();
    git('add', '-A');
    git('commit', '-qm', 'c');
    git('commit', '--amend', '-qm', 'c2');
    expect(reused(run())).toBe(true);
  });

  it('тень (shadow): прогон идёт, в ленте «повторил бы» и совпадение', () => {
    run({ AGENTDECK_VERIFY_LEDGER: 'shadow' });
    const second = run({ AGENTDECK_VERIFY_LEDGER: 'shadow' });
    expect(reused(second)).toBe(false);
    const kinds = events().map((e) => e.kind);
    expect(kinds).toContain('would-skip');
    expect(kinds).toContain('shadow-ok');
    expect(kinds).not.toContain('mismatch');
  });

  it('T26: тень замечает расхождение кода прогона с записью', () => {
    run();
    // Тот же ключ, другой исход: код берётся из файла вне репозитория — журнал его не видит.
    outside({ FAKE_EXIT: '1' });
    run({ AGENTDECK_VERIFY_LEDGER: 'shadow' });
    expect(events().map((e) => e.kind)).toContain('mismatch');
  });

  it('T20: off — прогон как есть и запись, повтора нет', () => {
    run();
    const before = recordCount();
    const r = run({ AGENTDECK_VERIFY_LEDGER: 'off' });
    expect(reused(r)).toBe(false);
    expect(recordCount()).toBe(before + 1);
    // Режим в ленте — «off», а не тень: иначе плитка выдала бы выключенный журнал за замер.
    expect(events().find((e) => e.kind === 'would-skip')?.mode).toBe('off');
  });

  it('замок панели: off и shadow из команды модели повтор не выключают, строка повтора их не советует', () => {
    run();
    const lock = { AGENTDECK_VERIFY_LEDGER_LOCK: '1' };
    const off = run({ ...lock, AGENTDECK_VERIFY_LEDGER: 'off' });
    expect(reused(off)).toBe(true);
    expect(off.err).not.toContain('VERIFY_LEDGER=off');
    // Без замка (человек вне панели) строка называет выход — иначе ему нечем прогнать заново (F-127).
    expect(run().err).toContain('AGENTDECK_VERIFY_LEDGER=off forces a run');
    expect(reused(run({ ...lock, AGENTDECK_VERIFY_LEDGER: 'shadow' }))).toBe(true);
    // Пустой замок — свой инструмент снял его (mustfail): off снова действует.
    expect(reused(run({ AGENTDECK_VERIFY_LEDGER_LOCK: '', AGENTDECK_VERIFY_LEDGER: 'off' }))).toBe(
      false,
    );
  });

  // F-30: замок в окружении снимается командой модели (`LOCK=`, `env -u`, скрипт). Замок панели —
  // в пути входа preload, который ставит панель: окружение команды его не достаёт.
  it('замок во входе preload: снятый из окружения замок, off, чужой дом и _DELTA=off повтор не выключают', () => {
    const appData = join(root, 'appdata');
    const install = installLedger({ appData, sourceDir: DIR });
    expect(install.lockedPreload).toBeTruthy();
    const locked = { NODE_OPTIONS: `--require "${install.lockedPreload}"` };
    const ledgerHome = join(appData, 'verify-ledger');
    expect(run({ ...locked, AGENTDECK_VERIFY_LEDGER_HOME: ledgerHome }).code).toBe(0);
    const escape = run({
      ...locked,
      AGENTDECK_VERIFY_LEDGER_LOCK: '',
      AGENTDECK_VERIFY_LEDGER: 'off',
      AGENTDECK_VERIFY_LEDGER_DELTA: 'off',
      AGENTDECK_VERIFY_LEDGER_HOME: join(root, 'fresh-home'),
    });
    expect(reused(escape)).toBe(true);
    expect(existsSync(join(root, 'fresh-home'))).toBe(false);
    // Обычный вход (выбор человека без замка): off снова действует.
    expect(
      reused(
        run({
          NODE_OPTIONS: `--require "${install.preload}"`,
          AGENTDECK_VERIFY_LEDGER_HOME: ledgerHome,
          AGENTDECK_VERIFY_LEDGER: 'off',
        }),
      ),
    ).toBe(false);
  });
});

describe('verify-ledger: ключ видит то, что видит проверка', () => {
  it('T1: правка LF→CRLF — промах', () => {
    run();
    writeFileSync(join(repo, 'src.txt'), 'A\r\n');
    expect(reused(run())).toBe(false);
  });

  it('T2: игнорируемый .env.local — промах', () => {
    writeFileSync(join(repo, '.env.local'), 'VITE_X=1\n');
    run();
    writeFileSync(join(repo, '.env.local'), 'VITE_X=2\n');
    expect(reused(run())).toBe(false);
  });

  it('T3: скрытый lock-файл node_modules — промах', () => {
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'node_modules/.package-lock.json'), '{"v":1}');
    run();
    writeFileSync(join(repo, 'node_modules/.package-lock.json'), '{"v":2}');
    expect(reused(run())).toBe(false);
  });

  /**
   * Linux и macOS (git сверяет секунды mtime): правка того же размера в ту же секунду,
   * что и запись индекса, видна git только по «racy»-отсчёту — mtime самого индекса.
   * Копия индекса с новым mtime его теряла: снимок хешировал старое содержимое, и
   * зелёный прогон над D выдавался потом за прогон над C. На Windows (наносекунды)
   * тест зелёный и без правки.
   */
  it('правка в ту же секунду, что и запись индекса, — снимок видит её', () => {
    const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    pause(1_000 - (Date.now() % 1_000) + 5);
    writeFileSync(join(repo, 'src.txt'), 'C\n');
    git('add', 'src.txt');
    writeFileSync(join(repo, 'src.txt'), 'D\n');
    pause(1_200);
    expect(run().code).toBe(0);
    writeFileSync(join(repo, 'src.txt'), 'C\n');
    expect(reused(run())).toBe(false);
  });

  /**
   * git старше 2.40 (Apple Git 2.39, Ubuntu 22.04 — 2.34) не знает `--attr-source` и
   * отвечает 129: снимок падал, и журнал молчал на каждом прогоне. Старый git — обёртка
   * в PATH; на Windows execFile не запускает скрипт без расширения, там тест молчит.
   */
  it.skipIf(process.platform === 'win32')('git без --attr-source — журнал работает', () => {
    const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const bin = join(root, 'old-git');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\nfor a in "$@"; do case "$a" in --attr-source=*) echo "unknown option: $a" >&2; exit 129;; esac; done\nexec "${real}" "$@"\n`,
      { mode: 0o755 },
    );
    const old = { PATH: `${bin}:${process.env.PATH ?? ''}` };
    expect(run(old).code).toBe(0);
    expect(reused(run(old))).toBe(true);
    writeFileSync(join(repo, 'src.txt'), 'B\n');
    expect(reused(run(old))).toBe(false);
    expect(events().some((e) => e.reason?.includes('snapshot'))).toBe(false);
  });

  it('T5: TZ и CI — промах; слоты очереди и id сессии — повтор', () => {
    run();
    expect(reused(run({ AGENTDECK_HEAVY_SLOTS: '7', AGENTDECK_VERIFY_LEDGER_SESSION: 'x' }))).toBe(
      true,
    );
    expect(reused(run({ TZ: 'Asia/Tokyo' }))).toBe(false);
    expect(reused(run({ CI: '1' }))).toBe(false);
  });

  /** Журнал 19.10 20:23: сессия с preload overlay и группа без него — разные ключи на том же дереве. */
  it('preload local-overlay в NODE_OPTIONS — повтор; чужой --require — промах', () => {
    const overlay = join(root, 'local-overlay', 'preload.cjs').replace(/\\/g, '/');
    const other = join(root, 'other', 'preload.cjs').replace(/\\/g, '/');
    for (const file of [overlay, other]) {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '');
    }
    expect(run().code).toBe(0);
    const withOverlay = `--require "${PRELOAD}" --require "${overlay}"`;
    expect(reused(run({ NODE_OPTIONS: withOverlay }))).toBe(true);
    expect(reused(run({ NODE_OPTIONS: `--require "${PRELOAD}" --require "${other}"` }))).toBe(
      false,
    );
  });

  it('T10: правка игнорируемой машинерии (модуль, который импортирует проверка) — промах', () => {
    run();
    writeFileSync(join(repo, '.claude/tools/helper.mjs'), 'export const helper = () => "v2";\n');
    const r = run();
    expect(reused(r)).toBe(false);
    expect(r.out).toContain('v2');
  });

  it('T9: двинулась база проверки «относительно ветки» — промах', () => {
    registry({ base: 'base-ref' });
    git('branch', 'base-ref');
    run();
    expect(reused(run())).toBe(true);
    // База уходит вперёд, а слияние `-s ours` оставляет рабочее дерево прежним:
    // содержимое то же, merge-base — другой коммит с другим деревом.
    git('checkout', '-q', 'base-ref');
    writeFileSync(join(repo, 'other.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'moves base');
    git('checkout', '-q', '-');
    git('merge', '-q', '-s', 'ours', 'base-ref', '-m', 'keep ours');
    expect(existsSync(join(repo, 'other.txt'))).toBe(false);
    expect(reused(run())).toBe(false);
  });

  it('T30: неотслеживаемый файл больше предела — журнал молчит; .gitmodules — тоже', () => {
    writeFileSync(join(repo, 'big.log'), Buffer.alloc(6 * 1024 * 1024));
    run();
    expect(recordCount()).toBe(0);
    expect(events().some((e) => e.reason === 'untracked-large')).toBe(true);
    rmSync(join(repo, 'big.log'));
    writeFileSync(join(repo, '.gitmodules'), '');
    run();
    expect(events().some((e) => e.reason === 'submodules')).toBe(true);
  });
});

describe('verify-ledger: запись только честного прогона', () => {
  it('T6: правка дерева посреди прогона — записи нет', () => {
    run({ FAKE_EDIT: '1' });
    expect(recordCount()).toBe(0);
  });

  it('T7: правка с откатом посреди прогона (A→B→A) — записи нет', () => {
    run({ FAKE_EDIT: '1', FAKE_REVERT: '1' });
    expect(readFileSync(join(repo, 'src.txt'), 'utf8')).toBe('A\n');
    expect(recordCount()).toBe(0);
    expect(reused(run())).toBe(false);
  });

  it('T8: убитый процесс — записи нет', async () => {
    const child = spawn(process.execPath, ['.claude/tools/check.mjs'], {
      cwd: repo,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require "${PRELOAD}"`,
        AGENTDECK_VERIFY_LEDGER_HOME: home,
        FAKE_SLEEP: '5000',
      },
      stdio: 'ignore',
    });
    await new Promise((r) => setTimeout(r, 1500));
    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', r));
    expect(recordCount()).toBe(0);
  });

  it('T11: красный на ключе — повтора нет никогда, даже после зелёного', () => {
    // Красный и зелёный на ОДНОМ ключе: исход — мимо ключа.
    outside({ FAKE_EXIT: '1' });
    run();
    outside({});
    run({ AGENTDECK_VERIFY_LEDGER: 'off' });
    const r = run();
    expect(reused(r)).toBe(false);
    expect(events().some((e) => e.reason === 'red-at-key')).toBe(true);
  });

  it('T12: красный и зелёный разом на одном ключе — обе записи целы', () => {
    const store = storeOf();
    const key = 'f'.repeat(64);
    const base = { key, checkId: 'c', check: 'fake', startedAt: Date.now(), ms: 1 };
    const out = { stdout: Buffer.from('a'), stderr: Buffer.alloc(0), complete: true };
    ledger.writeRecord(store, { ...base, exit: 0, reusedFrom: null }, out);
    ledger.writeRecord(store, { ...base, exit: 1, reusedFrom: null }, out);
    expect(
      ledger
        .records(store, key)
        .map((r) => r.exit)
        .sort(),
    ).toEqual([0, 1]);
    expect(ledger.decide(store, key).reason).toBe('red-at-key');
  });

  it('T15: вывод больше предела — записи нет; ребёнок с inherit — без повтора', () => {
    run({ FAKE_BIG: String(5 * 1024 * 1024) });
    expect(recordCount()).toBe(0);
    // Причина — именно предел захвата: без него захват копил бы весь вывод в память.
    expect(events().some((e) => e.reason === 'output-cap')).toBe(true);
    run({ FAKE_INHERIT: '1' });
    expect(recordCount()).toBe(1);
    expect(reused(run({ FAKE_INHERIT: '1' }))).toBe(false);
    expect(events().some((e) => e.reason === 'output-incomplete')).toBe(true);
  });

  it('служба esbuild со stderr inherit не делает вывод неполным — vitest повторяется', () => {
    run({ FAKE_ESBUILD: '1' });
    expect(recordCount()).toBe(1);
    expect(reused(run({ FAKE_ESBUILD: '1' }))).toBe(true);
    expect(events().some((e) => e.reason === 'output-incomplete')).toBe(false);
  });

  it('повтор в stdout, который никто не читает (EAGAIN), — не крутит ядро и выходит', () => {
    // Граница подмены — системный вызов записи: шим отвечает EAGAIN на fd 1, как
    // неблокирующий канал, который читатель перестал опустошать. Прежний writeAll
    // повторял без паузы и без срока — процесс не выходил никогда (spawnSync ниже
    // срубал его по таймауту), крутя миллионы попыток.
    const shim = join(root, 'eagain-shim.cjs').replace(/\\/g, '/');
    const calls = join(root, 'eagain-calls.txt');
    writeFileSync(
      shim,
      // Включается файлом, а не окружением: окружение в ключе, а повтор нужен тот же.
      `const fs = require('node:fs');
const calls = ${JSON.stringify(calls)};
if (fs.existsSync(calls + '.on')) {
  const original = fs.writeSync;
  let n = 0;
  fs.writeSync = function (fd, ...rest) {
    if (fd !== 1) return original.call(fs, fd, ...rest);
    n += 1;
    const e = new Error('EAGAIN: resource temporarily unavailable, write');
    e.code = 'EAGAIN';
    throw e;
  };
  process.on('exit', () => fs.writeFileSync(calls, String(n)));
}
`,
    );
    const both = { NODE_OPTIONS: `--require "${shim}" --require "${PRELOAD}"` };
    expect(run(both).code).toBe(0);
    writeFileSync(`${calls}.on`, '');
    const startedAt = Date.now();
    const r = spawnSync(process.execPath, ['.claude/tools/check.mjs'], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...baseEnv,
        ...both,
        AGENTDECK_VERIFY_LEDGER_HOME: home,
        AGENTDECK_VERIFY_LEDGER: 'on',
        AGENTDECK_VERIFY_LEDGER_LOCK: '',
        AGENTDECK_VERIFY_LEDGER_WRITE_MS: '300',
        FAKE_CTL: join(root, 'ctl.json'),
      },
      timeout: 10_000,
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('[verify-ledger] reused green');
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    // Сон между попытками: за ~300 мс — десятки попыток, не миллионы.
    const attempts = Number(readFileSync(calls, 'utf8'));
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThan(200);
  });

  it('git журнала со сроком: не успел — проверка идёт как есть, причина в ленте', () => {
    // Срок 1 мс не успевает ни один настоящий git: без срока журнал записал бы
    // прогон как обычно (miss → record), со сроком — отступает и не держит проверку.
    const r = run({ AGENTDECK_VERIFY_LEDGER_GIT_MS: '1' });
    expect(r.code).toBe(0);
    expect(reused(r)).toBe(false);
    const kinds = events().map((e) => e.kind);
    expect(kinds).not.toContain('record');
    expect(kinds).toContain('off');
    expect(recordCount()).toBe(0);
  });

  it('T19: подложенная руками запись без подписи не считается', () => {
    run({ AGENTDECK_VERIFY_LEDGER: 'off', FAKE_EXIT: '1' });
    const dir = join(storeOf().store, 'v1', 'runs');
    const sub = readdirSync(dir)[0]!;
    const name = readdirSync(join(dir, sub))[0]!;
    const rec = JSON.parse(readFileSync(join(dir, sub, name), 'utf8')) as Record<string, unknown>;
    // Подделка: красный переписан в зелёный под тем же ключом, подпись старая.
    writeFileSync(join(dir, sub, name), JSON.stringify({ ...rec, exit: 0 }));
    expect(ledger.records(storeOf(), rec.key as string)).toHaveLength(0);
  });
});

describe('verify-ledger: артефакты и флаги', () => {
  it('T16: штамп под git-path возвращается к байтам своего дерева', () => {
    const stamp = join(repo, '.git', 'stamp.json');
    registry({ artifacts: [{ gitPath: 'stamp.json' }] });
    run({ FAKE_STAMP: stamp });
    expect(readFileSync(stamp, 'utf8')).toBe('stamp-A\n');
    writeFileSync(join(repo, 'src.txt'), 'B\n');
    run({ FAKE_STAMP: stamp });
    expect(readFileSync(stamp, 'utf8')).toBe('stamp-B\n');
    writeFileSync(join(repo, 'src.txt'), 'A\n');
    expect(reused(run({ FAKE_STAMP: stamp }))).toBe(true);
    expect(readFileSync(stamp, 'utf8')).toBe('stamp-A\n');
  });

  it('T13: флаги, пишущие файлы, — никогда не повтор; watch и --write — не проверка', () => {
    const vitest = join(repo, 'node_modules/vitest/vitest.mjs');
    const argv = (...a: string[]) => ['node', vitest, ...a];
    expect(recognize(argv('run'), repo)?.noSkip).toBeNull();
    for (const flags of [
      ['run', '--coverage'],
      ['run', '-u'],
    ]) {
      expect(recognize(argv(...flags), repo)?.noSkip).toBeTruthy();
    }
    // Отчёт в файл или в stdout — повтор можно (байты отчёта в записи), сужение нельзя.
    for (const flags of [
      ['run', '--outputFile=x.xml'],
      ['run', '--outputFile.junit', 'x.xml'],
      ['run', '--reporter', 'junit'],
      ['run', '--reporter=junit'],
    ]) {
      const m = recognize(argv(...flags), repo) as { noSkip: null; wholeOnly: boolean } | null;
      expect(m?.noSkip).toBeNull();
      expect(m?.wholeOnly).toBe(true);
    }
    expect(recognize(argv(), repo)).toBeNull();
    expect(recognize(argv('related', 'a.ts'), repo)).toBeNull();
    expect(recognize(argv('related', 'a.ts', '--run'), repo)?.id).toBe('vitest');
    const prettier = join(repo, 'node_modules/prettier/bin/prettier.cjs');
    expect(recognize(['node', prettier, '--check', '.'], repo)?.id).toBe('prettier');
    expect(recognize(['node', prettier, '--write', '.'], repo)).toBeNull();
    const eslint = join(repo, 'node_modules/eslint/bin/eslint.js');
    expect(recognize(['node', eslint, '--fix', '.'], repo)).toBeNull();
    const tsc = join(repo, 'node_modules/typescript/bin/tsc');
    expect(recognize(['node', tsc, '--noEmit'], repo)?.id).toBe('tsc');
    expect(recognize(['node', tsc, '-b'], repo)).toBeNull();
  });
});

describe('verify-ledger: preload никогда не роняет node', () => {
  it('T17: сломанный модуль журнала — процесс всё равно идёт', () => {
    const broken = join(root, 'broken');
    mkdirSync(broken);
    writeFileSync(join(broken, 'preload.cjs'), readFileSync(join(DIR, 'preload.cjs')));
    writeFileSync(join(broken, 'checks.cjs'), 'throw new Error("boom")');
    const r = spawnSync(process.execPath, ['-e', 'console.log("alive")'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: `--require "${join(broken, 'preload.cjs').replace(/\\/g, '/')}"`,
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('alive');
  });

  it('T18: обычный процесс node — без git и без записи в ленту', () => {
    const r = spawnSync(
      process.execPath,
      ['-e', 'new (require("worker_threads").Worker)("1", { eval: true }); console.log("ok")'],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: `--require "${PRELOAD}"`,
          AGENTDECK_VERIFY_LEDGER_HOME: home,
        },
      },
    );
    expect(r.stdout.trim()).toBe('ok');
    expect(events()).toHaveLength(0);
    expect(existsSync(join(repo, '.git', 'agentdeck-verify'))).toBe(false);
  });
});
