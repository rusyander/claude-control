import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Журнал проверок в монорепо с копиями (`git worktree`) — живой node с настоящим
 * `--require` и настоящим git. Владелец 19.10: зелёный прогон копии не годился
 * ни соседней копии, ни основной папке (хранилище было своё у каждой), а правка в
 * одном пакете гнала tsc/eslint/prettier всех (ключ — всё дерево целиком).
 * Наивные реализации, на которых тесты краснеют: хранилище через `--git-path`;
 * ключ по `write-tree` всего репозитория.
 */
const PRELOAD = resolve(__dirname, '../../../../../tools/verify-ledger/preload.cjs').replace(
  /\\/g,
  '/',
);

/** Поддельный tsc по пути, который журнал узнаёт как общий инструмент. */
const FAKE_TSC = "console.log('tsc: 0 errors');\n";

let root: string;
let main: string;
let home: string;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function put(base: string, rel: string, body: string) {
  mkdirSync(join(base, rel, '..'), { recursive: true });
  writeFileSync(join(base, rel), body);
}

/** Неотслеживаемый инструмент пакета: в копию git его не приносит. */
function tool(base: string, pkg: string) {
  put(base, `${pkg}/node_modules/typescript/bin/tsc`, FAKE_TSC);
}

function tsc(base: string, pkg: string) {
  const r = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], {
    cwd: join(base, pkg),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: `--require "${PRELOAD}"`,
      AGENTDECK_VERIFY_LEDGER_HOME: home,
      AGENTDECK_VERIFY_LEDGER: 'on',
    },
    timeout: 30_000,
  });
  expect(r.status).toBe(0);
  return r.stderr.includes('[verify-ledger] reused green');
}

/** Поддельный vitest: пишет отчёт с меткой прогона туда, куда велит `--outputFile.junit`. */
const FAKE_VITEST = `
import fs from 'node:fs';
import path from 'node:path';
const arg = process.argv.find((a) => a.startsWith('--outputFile.junit='));
const file = arg.slice('--outputFile.junit='.length);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, '<testsuites run="' + process.pid + '-' + Date.now() + '"/>');
console.log('Test Files  1 passed');
`;

function vitest(base: string, pkg: string, report: string) {
  const r = spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--reporter=junit', `--outputFile.junit=${report}`],
    {
      cwd: join(base, pkg),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: `--require "${PRELOAD}"`,
        AGENTDECK_VERIFY_LEDGER_HOME: home,
        AGENTDECK_VERIFY_LEDGER: 'on',
      },
      timeout: 30_000,
    },
  );
  expect(r.status).toBe(0);
  return {
    reused: r.stderr.includes('[verify-ledger] reused green'),
    report: readFileSync(report, 'utf8'),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-ledger-copies-'));
  main = join(root, 'main');
  home = join(root, 'home');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 't@example.com');
  git(main, 'config', 'user.name', 't');
  put(main, '.gitattributes', '* text=auto eol=lf\n');
  put(main, '.gitignore', 'node_modules/\n');
  put(main, 'package.json', '{"private":true}\n');
  put(main, 'pkg-a/package.json', '{"name":"pkg-a"}\n');
  // Сосед через путь конфига, без зависимости рабочей области.
  put(
    main,
    'pkg-a/tsconfig.json',
    '{"compilerOptions":{"paths":{"@shared/*":["../shared/src/*"]}}}\n',
  );
  put(main, 'pkg-a/src/a.ts', 'export const a = 1;\n');
  put(main, 'pkg-b/package.json', '{"name":"pkg-b"}\n');
  put(main, 'pkg-b/src/b.ts', 'export const b = 1;\n');
  put(main, 'shared/src/s.ts', 'export const s = 1;\n');
  put(main, 'docs/page.mdx', '# A\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  tool(main, 'pkg-a');
  tool(main, 'pkg-b');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('verify-ledger: копии и пакеты монорепо', () => {
  it('зелёный прогон основной папки повторяется в копии с тем же деревом, и обратно', () => {
    expect(tsc(main, 'pkg-a')).toBe(false);
    const copy = join(root, 'copy');
    git(main, 'worktree', 'add', '-q', copy, 'HEAD');
    tool(copy, 'pkg-a');
    tool(copy, 'pkg-b');
    expect(tsc(copy, 'pkg-a')).toBe(true);
    // Обратное направление: первым прогнан pkg-b в копии — основная папка берёт его.
    expect(tsc(copy, 'pkg-b')).toBe(false);
    expect(tsc(main, 'pkg-b')).toBe(true);
    // Правка в копии — её дерево другое: основной папке повтор, копии — прогон.
    put(copy, 'pkg-a/src/a.ts', 'export const a = 2;\n');
    expect(tsc(copy, 'pkg-a')).toBe(false);
    expect(tsc(main, 'pkg-a')).toBe(true);
  });

  it('правка в чужом пакете и в документации ключ пакета не меняет', () => {
    expect(tsc(main, 'pkg-a')).toBe(false);
    put(main, 'pkg-b/src/b.ts', 'export const b = 2;\n');
    put(main, 'docs/page.mdx', '# B\n');
    expect(tsc(main, 'pkg-a')).toBe(true);
    expect(tsc(main, 'pkg-b')).toBe(false);
  });

  it('прогон с junit-отчётом по новому временному пути — повтор, отчёт ложится по новому пути', () => {
    put(main, 'pkg-a/node_modules/vitest/vitest.mjs', FAKE_VITEST);
    const first = vitest(main, 'pkg-a', join(root, 'r1', 'report.xml'));
    expect(first.reused).toBe(false);
    const second = vitest(main, 'pkg-a', join(root, 'r2', 'report.xml'));
    expect(second.reused).toBe(true);
    expect(second.report).toBe(first.report);
    // Правка пакета — прогон, отчёт свежий.
    put(main, 'pkg-a/src/a.ts', 'export const a = 3;\n');
    const third = vitest(main, 'pkg-a', join(root, 'r3', 'report.xml'));
    expect(third.reused).toBe(false);
    expect(third.report).not.toBe(first.report);
  });

  it('правка соседа из пути конфига, файла корня или своего пакета — прогон', () => {
    expect(tsc(main, 'pkg-a')).toBe(false);
    put(main, 'shared/src/s.ts', 'export const s = 2;\n');
    expect(tsc(main, 'pkg-a')).toBe(false);
    put(main, 'package.json', '{"private":true,"x":1}\n');
    expect(tsc(main, 'pkg-a')).toBe(false);
    put(main, 'pkg-a/src/new.ts', 'export const n = 1;\n');
    expect(tsc(main, 'pkg-a')).toBe(false);
    expect(tsc(main, 'pkg-a')).toBe(true);
  });
});
