import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Журнал проверок, стадия 3 — прогон «от последнего зелёного» (`tools/verify-ledger/delta.cjs`)
 * и снимок дерева в копии, где `.agent` игнорирует `.gitignore` (19.10 журнал из-за этого
 * не видел ни одного прогона групп). Живые процессы node с настоящим `--require` и git;
 * vitest — подделка по тому же пути `node_modules/vitest/vitest.mjs`, печатающая свои
 * аргументы: так видно, во что журнал превратил запуск.
 */
const DIR = resolve(__dirname, '../../../../../tools/verify-ledger');
const PRELOAD = join(DIR, 'preload.cjs').replace(/\\/g, '/');

// Код выхода — окружением (оно в ключе и в семействе сужения) или файлом вне репозитория `FAKE_CTL`.
const FAKE_VITEST = `import fs from 'node:fs';
console.log('ARGS ' + JSON.stringify(process.argv.slice(2)));
const ctl = process.env.FAKE_CTL && fs.existsSync(process.env.FAKE_CTL) ? JSON.parse(fs.readFileSync(process.env.FAKE_CTL, 'utf8')) : {};
process.exitCode = Number(ctl.FAKE_EXIT || process.env.FAKE_EXIT || 0);
`;

let root: string;
let repo: string;
let web: string;
let home: string;

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const put = (rel: string, body: string) => {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), body);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-ledger-delta-'));
  repo = join(root, 'repo');
  web = join(repo, 'web');
  home = join(root, 'home');
  mkdirSync(repo, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  // `.agent` в .gitignore и на диске — ровно как в реальном проекте, где журнал его не видел.
  put('.gitignore', '.agent/\nnode_modules/\n');
  put('.agent/notes.md', 'local\n');
  put('web/package.json', '{"name":"web","dependencies":{"lib":"file:../lib"}}\n');
  put(
    'web/vitest.config.ts',
    "export default { test: { setupFiles: ['./src/testing/setup.ts'] } };\n",
  );
  put('web/src/testing/setup.ts', 'export {};\n');
  put('web/src/a.ts', 'export const a = 1;\n');
  put('web/src/b.ts', 'export const b = 1;\n');
  put('web/src/c.ts', 'export const c = 1;\n');
  put('web/src/feature/testing/helper.ts', 'export const h = 1;\n');
  put('web/README.md', 'readme\n');
  put('lib/index.ts', 'export const l = 1;\n');
  put('other/x.ts', 'export const x = 1;\n');
  put('web/node_modules/vitest/vitest.mjs', FAKE_VITEST);
  git('add', '-A');
  git('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Run = { code: number | null; args: string[] | null; err: string };

function vitest(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', ...args], {
    cwd: web,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: `--require "${PRELOAD}"`,
      AGENTDECK_VERIFY_LEDGER_HOME: home,
      AGENTDECK_VERIFY_LEDGER: '',
      // Прогон под панелью приносит её замок — тест сам решает, есть ли он.
      AGENTDECK_VERIFY_LEDGER_LOCK: '',
      FAKE_CTL: join(root, 'ctl.json'),
      ...env,
    },
    timeout: 30_000,
  });
  const line = r.stdout.split('\n').find((l) => l.startsWith('ARGS '));
  return {
    code: r.status,
    args: line ? (JSON.parse(line.slice(5)) as string[]) : null,
    err: r.stderr,
  };
}

// Пути related от пакета; настоящие абсолютные формы того же файла (junction, `RUSYAN~1`) — отдельно.
const rel = (a: string[] | null) => a?.filter((x) => !/^([a-z]:)?\//i.test(x)) ?? null;

const events = () =>
  existsSync(join(home, 'events.jsonl'))
    ? readFileSync(join(home, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { kind: string; reason?: string })
    : [];

describe('verify-ledger: снимок в копии с игнорируемым .agent', () => {
  it('прогон записан, а не выключен сбоем git add (дефект 19.10)', () => {
    expect(vitest(['run']).code).toBe(0);
    const kinds = events().map((e) => e.kind);
    expect(kinds).toContain('record');
    expect(events().filter((e) => e.kind === 'off')).toEqual([]);
  });

  it('пустой режим — это on: второй прогон того же дерева не идёт', () => {
    vitest(['run']);
    const second = vitest(['run']);
    expect(second.err).toContain('[verify-ledger] reused green');
  });
});

describe('verify-ledger: сужение от последнего зелёного', () => {
  it('правка модуля пакета — related только по изменённому файлу', () => {
    vitest(['run']);
    put('web/src/a.ts', 'export const a = 2;\n');
    const r = vitest(['run']);
    expect(rel(r.args)).toEqual(['related', 'src/a.ts', '--run', '--passWithNoTests']);
    expect(r.err).toContain('[verify-ledger] delta since green');
  });

  it('помощник в testing/ отдельной фичи — по графу, а не целиком', () => {
    vitest(['run']);
    put('web/src/feature/testing/helper.ts', 'export const h = 2;\n');
    expect(rel(vitest(['run']).args)).toEqual([
      'related',
      'src/feature/testing/helper.ts',
      '--run',
      '--passWithNoTests',
    ]);
  });

  it('цепочка: зелёное сужение — новая точка отсчёта', () => {
    vitest(['run']);
    put('web/src/a.ts', 'export const a = 2;\n');
    vitest(['run']);
    put('web/src/b.ts', 'export const b = 2;\n');
    expect(rel(vitest(['run']).args)).toEqual([
      'related',
      'src/b.ts',
      '--run',
      '--passWithNoTests',
    ]);
  });

  it.each([
    ['конфиг vitest', 'web/vitest.config.ts', 'export default {};\n'],
    ['файл setupFiles', 'web/src/testing/setup.ts', 'export const s = 1;\n'],
    ['соседний каталог из setupFiles', 'web/src/testing/msw.ts', 'export const m = 1;\n'],
    ['пакет, подключённый через file:', 'lib/index.ts', 'export const l = 2;\n'],
    ['не модуль (читается через fs)', 'web/README.md', 'changed\n'],
    ['package.json', 'web/package.json', '{"name":"web2"}\n'],
  ])('%s — прогон целиком', (_name, file, body) => {
    vitest(['run']);
    put(file, body);
    expect(vitest(['run']).args).toEqual(['run']);
  });

  it('удаление — целиком: граф удалённого файла не пройти', () => {
    vitest(['run']);
    rmSync(join(repo, 'web/src/c.ts'));
    expect(vitest(['run']).args).toEqual(['run']);
  });

  it('код вне всех пакетов — целиком: тест может исполнить его дочерним процессом', () => {
    vitest(['run']);
    put('other/x.ts', 'export const x = 2;\n');
    const r = vitest(['run']);
    expect(r.args).toEqual(['run']);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('reused');
  });

  it('правка документации вне пакета — повтор зелёного без прогона', () => {
    vitest(['run']);
    put('docs/page.md', '# B\n');
    const r = vitest(['run']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('[verify-ledger] nothing the tests can see changed');
  });

  it('код чужого пакета — related по нему путём от пакета, не повтор (ревью 25.10 R1)', () => {
    put('other/package.json', '{"name":"other"}\n');
    vitest(['run']);
    put('other/x.ts', 'export const x = 2;\n');
    const r = vitest(['run']);
    expect(rel(r.args)).toEqual(['related', '../other/x.ts', '--run', '--passWithNoTests']);
    expect(r.err).not.toContain('reused');
  });

  it('AGENTDECK_VERIFY_LEDGER_DELTA=off — целиком', () => {
    vitest(['run']);
    put('web/src/a.ts', 'export const a = 2;\n');
    expect(vitest(['run'], { AGENTDECK_VERIFY_LEDGER_DELTA: 'off' }).args).toEqual(['run']);
  });

  it('под замком панели _DELTA=off и shadow из команды модели сужение не выключают', () => {
    vitest(['run']);
    put('web/src/a.ts', 'export const a = 2;\n');
    const lock = { AGENTDECK_VERIFY_LEDGER_LOCK: '1' };
    const off = vitest(['run'], { ...lock, AGENTDECK_VERIFY_LEDGER_DELTA: 'off' });
    expect(off.args).not.toEqual(['run']);
    expect(off.args).toContain('related');
    // Строка сужения больше не подсказывает, как его выключить.
    expect(off.err).not.toContain('DELTA=off');
    put('web/src/a.ts', 'export const a = 3;\n');
    const shadow = vitest(['run'], { ...lock, AGENTDECK_VERIFY_LEDGER: 'shadow' });
    expect(shadow.args).toContain('related');
  });

  it('тень (shadow) не сужает: она только мерит', () => {
    vitest(['run']);
    put('web/src/a.ts', 'export const a = 2;\n');
    expect(vitest(['run'], { AGENTDECK_VERIFY_LEDGER: 'shadow' }).args).toEqual(['run']);
  });

  it('красный прогон не становится точкой отсчёта', () => {
    vitest(['run'], { FAKE_EXIT: '1' });
    put('web/src/a.ts', 'export const a = 2;\n');
    expect(vitest(['run']).args).toEqual(['run']);
  });

  it('красное сужение на том же дереве — дальше целиком', () => {
    vitest(['run']);
    put('web/src/a.ts', 'export const a = 2;\n');
    // Красный — мимо ключа: окружение сменило бы семейство, и сужения не было бы вовсе.
    writeFileSync(join(root, 'ctl.json'), JSON.stringify({ FAKE_EXIT: '1' }));
    expect(vitest(['run']).args?.[0]).toBe('related');
    writeFileSync(join(root, 'ctl.json'), '{}');
    expect(vitest(['run']).args).toEqual(['run']);
  });

  it('related: новый файл, которого не было в зелёном, сужение снимает', () => {
    vitest(['related', 'src/a.ts', '--run']);
    put('web/src/b.ts', 'export const b = 2;\n');
    // b изменён — входит в Δ; a не менялся и был в зелёном.
    expect(rel(vitest(['related', 'src/a.ts', 'src/b.ts', '--run']).args)).toEqual([
      'related',
      'src/b.ts',
      '--run',
      '--passWithNoTests',
    ]);
    // c не менялся и в зелёных его не было — его тесты не шли ни разу.
    expect(vitest(['related', 'src/c.ts', '--run']).args).toEqual(['related', 'src/c.ts', '--run']);
  });

  it('junit-отчёт не сужается: потребитель отчёта ждёт весь набор', () => {
    vitest(['run', '--reporter=junit']);
    put('web/src/a.ts', 'export const a = 2;\n');
    expect(vitest(['run', '--reporter=junit']).args).toEqual(['run', '--reporter=junit']);
  });
});
