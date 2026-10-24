import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Журнал проверок — сужение прогона списка файлов (`vitest run F`, `tools/verify-ledger/delta.cjs`).
 * 24–25.10: 660 из 729 записанных промахов vitest были такими, и ни один не сужался — ключ брал
 * всё дерево, правка в любом месте копии гнала весь F заново. Живые процессы node с настоящим
 * `--require` и git. Первая часть — vitest-подделка, печатающая argv и Δ поставщика; вторая —
 * настоящий vitest репозитория: только он показывает, что `--changed` с поставщиком журнала
 * действительно берёт из F лишь тесты, чей граф задевает Δ.
 *
 * `LEDGER_SRC_UNDER_TEST` — каталог журнала для сверки «до правки» (копия из `git show HEAD:`).
 */
const DIR =
  process.env.LEDGER_SRC_UNDER_TEST ?? resolve(__dirname, '../../../../../tools/verify-ledger');
const PRELOAD = join(DIR, 'preload.cjs').replace(/\\/g, '/');
const REAL_VITEST = resolve(__dirname, '../../../node_modules/vitest/vitest.mjs');

const FAKE_VITEST = `import fs from 'node:fs';
console.log('ARGS ' + JSON.stringify(process.argv.slice(2)));
console.log('DELTA ' + (process.env.AGENTDECK_VERIFY_LEDGER_DELTA_FILES ?? 'none'));
const ctl = process.env.FAKE_CTL && fs.existsSync(process.env.FAKE_CTL) ? JSON.parse(fs.readFileSync(process.env.FAKE_CTL, 'utf8')) : {};
const out = process.argv.find((a) => a.startsWith('--outputFile='));
if (out && !ctl.NO_REPORT) fs.writeFileSync(out.slice('--outputFile='.length), '<testsuites stamp="' + process.pid + '"/>');
process.exitCode = Number(ctl.FAKE_EXIT || 0);
`;

let root: string;
let repo: string;
let pkg: string;
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

function initRepo(files: Record<string, string>) {
  root = mkdtempSync(join(tmpdir(), 'cc-ledger-files-'));
  repo = join(root, 'repo');
  pkg = join(repo, 'pkg');
  home = join(root, 'home');
  mkdirSync(repo, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  put('.gitignore', 'node_modules/\n');
  for (const [rel, body] of Object.entries(files)) put(rel, body);
  git('add', '-A');
  git('commit', '-qm', 'init');
}
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Run = { code: number | null; out: string; err: string };

function node(script: string, args: string[], env: Record<string, string> = {}, cwd = pkg): Run {
  // Свой vitest внутри теста не должен думать, что он рабочий поток внешнего.
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(VITEST|TEST$|NODE_OPTIONS$)/.test(k)),
  );
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...clean,
      NODE_OPTIONS: `--require "${PRELOAD}"`,
      AGENTDECK_VERIFY_LEDGER_HOME: home,
      AGENTDECK_VERIFY_LEDGER: '',
      AGENTDECK_VERIFY_LEDGER_LOCK: '',
      AGENTDECK_VERIFY_LEDGER_DELTA: '',
      FAKE_CTL: join(root, 'ctl.json'),
      ...env,
    },
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const args = (r: Run) => {
  const line = r.out.split('\n').find((l) => l.startsWith('ARGS '));
  return line ? (JSON.parse(line.slice(5)) as string[]) : null;
};
const deltaAll = (r: Run) => {
  const line = r.out.split('\n').find((l) => l.startsWith('DELTA ')) ?? 'DELTA none';
  const raw = line.slice(6).trim();
  return raw === 'none' ? null : (JSON.parse(raw) as { files: string[] }).files;
};
// Пути от пакета; настоящие абсолютные формы того же файла (junction, `RUSYAN~1`) — отдельно.
const delta = (r: Run) =>
  deltaAll(r)
    ?.filter((f) => !/^([a-z]:)?\//i.test(f))
    .sort() ?? null;
const events = () =>
  existsSync(join(home, 'events.jsonl'))
    ? readFileSync(join(home, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { kind: string; mode?: string; delta?: number })
    : [];

const LIST = ['run', 'src/a.test.ts'];

describe('verify-ledger: список файлов — повтор и сужение (vitest-подделка)', () => {
  const fake = (version: string) => ({
    'pkg/package.json': '{"name":"pkg"}\n',
    'pkg/vitest.config.ts':
      "export default { test: { setupFiles: ['./src/testing/setup.ts'] } };\n",
    'pkg/src/testing/setup.ts': 'export {};\n',
    'pkg/src/a.ts': 'export const a = 1;\n',
    'pkg/src/a.test.ts':
      "import { a } from './a.ts';\nconst FAKE = 'fake.mjs';\nconst DATA = 'changelog';\n",
    'pkg/src/b.ts': 'export const b = 1;\n',
    'pkg/src/__fixtures__/fake.mjs': 'console.log(1);\n',
    'pkg/node_modules/vitest/vitest.mjs': FAKE_VITEST,
    'pkg/node_modules/vitest/package.json': `{"name":"vitest","version":"${version}"}\n`,
    'other/package.json': '{"name":"other"}\n',
    'other/x.ts': 'export const x = 1;\n',
    'docs/page.md': '# A\n',
    'changelog/e.json': '{}\n',
    'tools/run.mjs': 'console.log(1);\n',
  });
  const vitest = (a: string[], env: Record<string, string> = {}) =>
    node('node_modules/vitest/vitest.mjs', a, env);
  beforeEach(() => initRepo(fake('4.1.10')));

  it('правка вне всего, что видят тесты F, — повтор зелёного, а не весь F заново', () => {
    expect(vitest(LIST).code).toBe(0);
    put('docs/page.md', '# B\n');
    const r = vitest(LIST);
    expect(r.code).toBe(0);
    expect(r.err).toContain('[verify-ledger] nothing the tests can see changed since green');
    expect(events().at(-1)).toMatchObject({ kind: 'hit', delta: 0, mode: 'files' });
  });

  it('код чужого пакета — в Δ путём от пакета, не повтор (алиас и ../ граф видит, ревью 25.10 R1)', () => {
    vitest(LIST);
    put('other/x.ts', 'export const x = 2;\n');
    const r = vitest(LIST);
    expect(r.err).not.toContain('reused');
    expect(delta(r)).toEqual(['../other/x.ts']);
    // Настоящая форма того же файла — для графа, что держит модули по `/@fs/`.
    expect(deltaAll(r)?.some((f) => f.endsWith('/other/x.ts') && f !== '../other/x.ts')).toBe(true);
  });

  it('правка в пакете — тот же F, Δ отдаёт поставщик, строка о сужении напечатана', () => {
    vitest(LIST);
    put('pkg/src/b.ts', 'export const b = 2;\n');
    const r = vitest(LIST);
    expect(args(r)).toEqual([
      'run',
      'src/a.test.ts',
      '--changed',
      expect.stringMatching(/^--experimental\.vcsProvider=.*\/vcs-delta\.mjs$/),
      '--passWithNoTests',
    ]);
    expect(delta(r)).toEqual(['src/b.ts']);
    expect(r.err).toContain('limited to tests whose imports reach 1 changed file(s) (src/b.ts)');
    expect(events().filter((e) => e.kind === 'delta')).toMatchObject([{ mode: 'files' }]);
  });

  it('скрипт пакета, названный тестом текстом, — тест в Δ (граф дочерний процесс не видит)', () => {
    vitest(LIST);
    put('pkg/src/__fixtures__/fake.mjs', 'console.log(2);\n');
    expect(delta(vitest(LIST))).toEqual(['src/__fixtures__/fake.mjs', 'src/a.test.ts']);
  });

  it('данные вне пакетов, чей каталог назван тестом, — не повтор: тест в Δ', () => {
    vitest(LIST);
    put('changelog/e.json', '{"x":1}\n');
    const r = vitest(LIST);
    expect(r.err).not.toContain('reused');
    expect(delta(r)).toEqual(['src/a.test.ts']);
  });

  it.each([
    ['конфиг vitest', 'pkg/vitest.config.ts', 'export default {};\n'],
    ['файл setupFiles', 'pkg/src/testing/setup.ts', 'export const s = 1;\n'],
    ['package.json', 'pkg/package.json', '{"name":"pkg2"}\n'],
    ['не модуль пакета', 'pkg/README.md', 'x\n'],
    ['код вне всех пакетов (20.10: тест гонял tools/*.mjs)', 'tools/run.mjs', 'console.log(2);\n'],
  ])('%s — весь F как набран', (_name, file, body) => {
    vitest(LIST);
    put(file, body);
    const r = vitest(LIST);
    expect(args(r)).toEqual(LIST);
    expect(delta(r)).toBeNull();
    expect(r.err).not.toContain('reused');
  });

  it('удаление — весь F', () => {
    vitest(LIST);
    rmSync(join(repo, 'pkg/src/b.ts'));
    expect(args(vitest(LIST))).toEqual(LIST);
  });

  it('другой список — другое семейство: зелёный чужого F не повторяется', () => {
    vitest(LIST);
    put('docs/page.md', '# B\n');
    const r = vitest(['run', 'src/a.test.ts', 'src/b.test.ts']);
    expect(args(r)).toEqual(['run', 'src/a.test.ts', 'src/b.test.ts']);
  });

  it('тот же список в другом порядке и с ./ — одно семейство', () => {
    vitest(['run', 'src/a.test.ts', 'src/b.ts']);
    put('docs/page.md', '# B\n');
    expect(vitest(['run', './src/b.ts', 'src/a.test.ts']).err).toContain(
      'nothing the tests can see',
    );
  });

  it('AGENTDECK_VERIFY_LEDGER_DELTA=off — весь F', () => {
    vitest(LIST);
    put('docs/page.md', '# B\n');
    const r = vitest(LIST, { AGENTDECK_VERIFY_LEDGER_DELTA: 'off' });
    expect(args(r)).toEqual(LIST);
  });

  it('красный F не становится точкой отсчёта', () => {
    writeFileSync(join(root, 'ctl.json'), JSON.stringify({ FAKE_EXIT: '1' }));
    vitest(LIST);
    writeFileSync(join(root, 'ctl.json'), '{}');
    put('docs/page.md', '# B\n');
    expect(args(vitest(LIST))).toEqual(LIST);
  });

  it('junit-отчёт: повтор кладёт отчёт по пути этого запуска, правка в пакете — весь F', () => {
    const first = join(root, 'r1.xml');
    vitest([...LIST, '--reporter=junit', `--outputFile=${first}`]);
    const body = readFileSync(first, 'utf8');
    put('docs/page.md', '# B\n');
    const second = join(root, 'r2.xml');
    const r = vitest([...LIST, '--reporter=junit', `--outputFile=${second}`]);
    expect(r.err).toContain('nothing the tests can see changed');
    expect(readFileSync(second, 'utf8')).toBe(body);
    put('pkg/src/b.ts', 'export const b = 2;\n');
    const third = join(root, 'r3.xml');
    expect(args(vitest([...LIST, '--reporter=junit', `--outputFile=${third}`]))).toEqual([
      ...LIST,
      '--reporter=junit',
      `--outputFile=${third}`,
    ]);
  });

  it('junit-отчёт, которого зелёный не оставил, — не повтор: F идёт и пишет отчёт (ревью 25.10)', () => {
    writeFileSync(join(root, 'ctl.json'), JSON.stringify({ NO_REPORT: 1 }));
    vitest([...LIST, '--reporter=junit', `--outputFile=${join(root, 'r1.xml')}`]);
    writeFileSync(join(root, 'ctl.json'), '{}');
    put('docs/page.md', '# B\n');
    const second = join(root, 'r2.xml');
    const r = vitest([...LIST, '--reporter=junit', `--outputFile=${second}`]);
    expect(r.err).not.toContain('reused');
    expect(args(r)).toEqual([...LIST, '--reporter=junit', `--outputFile=${second}`]);
    expect(existsSync(second)).toBe(true);
  });

  it.each([['--root'], ['-r'], ['--dir']])(
    '%s в команде — без сужения: пути Δ от пакета легли бы мимо корня vitest',
    (flag) => {
      const typed = [...LIST, flag, '.'];
      vitest(typed);
      put('pkg/src/b.ts', 'export const b = 2;\n');
      const r = vitest(typed);
      expect(args(r)).toEqual(typed);
      expect(delta(r)).toBeNull();
    },
  );

  it('vitest старее проверенного 4.1.10: повтор есть, сужения нет — весь F', () => {
    put('pkg/node_modules/vitest/package.json', '{"name":"vitest","version":"4.0.18"}\n');
    vitest(LIST);
    put('pkg/src/b.ts', 'export const b = 2;\n');
    expect(args(vitest(LIST))).toEqual(LIST);
  });
});

describe('verify-ledger: поставщик Δ (vcs-delta.mjs) падает, а не выбирает ноль тестов', () => {
  const provider = async () =>
    (
      (await import(pathToFileURL(join(DIR, 'vcs-delta.mjs')).href)) as {
        default: { findChangedFiles: (o: { root: string }) => Promise<string[]> };
      }
    ).default;
  let saved: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-ledger-vcs-'));
    saved = process.env.AGENTDECK_VERIFY_LEDGER_DELTA_FILES;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTDECK_VERIFY_LEDGER_DELTA_FILES;
    else process.env.AGENTDECK_VERIFY_LEDGER_DELTA_FILES = saved;
  });

  it('тот же корень — пути от пакета; без Δ и при чужом корне — ошибка', async () => {
    const p = await provider();
    mkdirSync(join(root, 'other'));
    process.env.AGENTDECK_VERIFY_LEDGER_DELTA_FILES = JSON.stringify({ root, files: ['src/a.ts'] });
    await expect(p.findChangedFiles({ root })).resolves.toEqual(['src/a.ts']);
    await expect(p.findChangedFiles({ root: join(root, 'other') })).rejects.toThrow(/vitest root/);
    delete process.env.AGENTDECK_VERIFY_LEDGER_DELTA_FILES;
    await expect(p.findChangedFiles({ root })).rejects.toThrow(/missing or empty/);
  });
});

describe('verify-ledger: список файлов на настоящем vitest', () => {
  beforeEach(() =>
    initRepo({
      'pkg/package.json': '{"name":"pkg","type":"module"}\n',
      'pkg/vitest.config.mjs': 'export default { test: { globals: true } };\n',
      'pkg/src/a.ts': 'export const a = 1;\n',
      'pkg/src/b.ts': 'export const b = 1;\n',
      'pkg/src/a.test.ts': "import { a } from './a.ts';\ntest('a', () => expect(a).toBe(1));\n",
      'pkg/src/b.test.ts': "import { b } from './b.ts';\ntest('b', () => expect(b).toBe(1));\n",
      'docs/page.md': '# A\n',
    }),
  );
  const F = ['run', 'src/a.test.ts', 'src/b.test.ts'];
  const real = () => node(REAL_VITEST, F, { NO_COLOR: '1', FORCE_COLOR: '0' });
  const files = (r: Run) => /Test Files\s+(.+)/.exec(r.out)?.[1];

  it('первый прогон — весь F; правка b — идёт только b.test; правка вне — повтор', () => {
    const first = real();
    expect(first.code, first.out + first.err).toBe(0);
    expect(files(first)).toMatch(/^2 passed/);
    put('pkg/src/b.ts', 'export const b = 1; // edit\n');
    const second = real();
    expect(second.code, second.out + second.err).toBe(0);
    expect(second.err).toContain('[verify-ledger] delta since green');
    expect(files(second), second.out).toMatch(/^1 passed \(1\)/);
    put('docs/page.md', '# B\n');
    const third = real();
    expect(third.code).toBe(0);
    expect(third.err).toContain('nothing the tests can see changed');
  }, 120_000);

  it('правка, ломающая тест F, — суженный прогон красный', () => {
    real();
    put('pkg/src/a.ts', 'export const a = 2;\n');
    const r = real();
    expect(r.code).toBe(1);
    expect(files(r)).toMatch(/^1 failed \(1\)/);
  }, 120_000);
});

/**
 * Каждый класс ложного зелёного из ревью 25.10 (R1–R5) — на настоящем vitest, обоими путями
 * сужения (`run F` и `run` → related): правка ломает тест, журнал обязан дать красный. Ни
 * в одном сценарии имя изменённого файла не стоит в тексте теста — иначе тест попал бы в Δ
 * сеткой упоминаний, и выбор по графу остался бы непроверенным.
 */
describe('verify-ledger: сужение на настоящем vitest не даёт ложного зелёного', () => {
  const T = (body: string) => `import { test, expect } from 'vitest';\n${body}\n`;
  const PKG = { 'pkg/package.json': '{"name":"pkg","type":"module"}\n' };
  const PLAIN = { 'pkg/vitest.config.mjs': 'export default {};\n' };
  const GRAPH = {
    ...PKG,
    ...PLAIN,
    'pkg/src/deep/x.ts': 'export const x = 1;\n',
    'pkg/src/mid.ts': "export { x } from './deep/x.ts';\n",
    'pkg/src/top.ts': "export { x } from './mid.ts';\n",
    'pkg/src/a.test.ts': T("import { x } from './top.ts';\ntest('x', () => expect(x).toBe(1));"),
  };
  type Scenario = { files: Record<string, string>; test: string; edit: [string, string] };
  const SCENARIOS: Record<string, Scenario> = {
    'зависимость через два реэкспорта (только граф)': {
      files: GRAPH,
      test: 'src/a.test.ts',
      edit: ['pkg/src/deep/x.ts', 'export const x = 2;\n'],
    },
    'алиас на соседний пакет (R1)': {
      files: {
        ...PKG,
        'pkg/vitest.config.mjs':
          "import { fileURLToPath } from 'node:url';\nexport default { resolve: { alias: [{ find: /^@lib\\/(.*)$/, replacement: fileURLToPath(new URL('../lib/src/$1.ts', import.meta.url)) }] } };\n",
        'lib/package.json': '{"name":"lib"}\n',
        'lib/src/x.ts': 'export const x = 1;\n',
        'pkg/src/a.test.ts': T("import { x } from '@lib/x';\ntest('x', () => expect(x).toBe(1));"),
      },
      test: 'src/a.test.ts',
      edit: ['lib/src/x.ts', 'export const x = 2;\n'],
    },
    'относительный импорт соседнего пакета (R1)': {
      files: {
        ...PKG,
        ...PLAIN,
        'lib/package.json': '{"name":"lib"}\n',
        'lib/src/x.ts': 'export const x = 1;\n',
        'pkg/src/a.test.ts': T(
          "import { x } from '../../lib/src/x.ts';\ntest('x', () => expect(x).toBe(1));",
        ),
      },
      test: 'src/a.test.ts',
      edit: ['lib/src/x.ts', 'export const x = 2;\n'],
    },
    'данные пакета через fs (R2)': {
      files: {
        ...PKG,
        ...PLAIN,
        'pkg/src/data/cfg.json': '{"n":1}\n',
        'pkg/src/a.test.ts': T(
          "import { readFileSync } from 'node:fs';\ntest('cfg', () => expect(JSON.parse(readFileSync(new URL('./data/' + 'cfg.json', import.meta.url), 'utf8')).n).toBe(1));",
        ),
      },
      test: 'src/a.test.ts',
      edit: ['pkg/src/data/cfg.json', '{"n":2}\n'],
    },
    'тест обходит каталог readdirSync (R3)': {
      files: {
        ...PKG,
        ...PLAIN,
        'pkg/src/b.ts': 'export const b = 1;\n',
        'pkg/src/scan.test.ts': T(
          "import { readdirSync, readFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nconst dir = fileURLToPath(new URL('.', import.meta.url));\ntest('no FIXME', () => { for (const f of readdirSync(dir)) if (!f.endsWith('.test.ts')) expect(readFileSync(dir + f, 'utf8')).not.toContain('FIX' + 'ME'); });",
        ),
      },
      test: 'src/scan.test.ts',
      edit: ['pkg/src/b.ts', 'export const b = 1; // FIXME\n'],
    },
    'обход каталога в помощнике теста (R3)': {
      files: {
        ...PKG,
        ...PLAIN,
        'pkg/src/b.ts': 'export const b = 1;\n',
        'pkg/src/test-utils/scan.ts':
          "import { readdirSync, readFileSync } from 'node:fs';\nexport const sources = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => readFileSync(dir + f, 'utf8'));\n",
        'pkg/src/scan.test.ts': T(
          "import { fileURLToPath } from 'node:url';\nimport { sources } from './test-utils/scan.ts';\ntest('no FIXME', () => { for (const t of sources(fileURLToPath(new URL('.', import.meta.url)))) expect(t).not.toContain('FIX' + 'ME'); });",
        ),
      },
      test: 'src/scan.test.ts',
      edit: ['pkg/src/b.ts', 'export const b = 1; // FIXME\n'],
    },
    'setupFiles через два импорта (R4)': {
      files: {
        ...PKG,
        'pkg/vitest.config.mjs':
          "export default { test: { setupFiles: ['./vitest.setup.ts'] } };\n",
        'pkg/vitest.setup.ts': "import './src/env/index.ts';\n",
        'pkg/src/env/index.ts': "import './globals.ts';\n",
        'pkg/src/env/globals.ts': 'globalThis.FLAG = 1;\n',
        'pkg/src/a.test.ts': T("test('flag', () => expect(globalThis.FLAG).toBe(1));"),
      },
      test: 'src/a.test.ts',
      edit: ['pkg/src/env/globals.ts', 'globalThis.FLAG = 2;\n'],
    },
    'тест исполняет модуль дочерним процессом': {
      files: {
        ...PKG,
        ...PLAIN,
        'pkg/src/lib/v.mjs': 'export const v = 1;\n',
        'pkg/src/main.mjs': "import { v } from './lib/v.mjs';\nconsole.log(v);\n",
        'pkg/src/a.test.ts': T(
          "import { spawnSync } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\ntest('v', () => expect(spawnSync(process.execPath, [fileURLToPath(new URL('./main.mjs', import.meta.url))], { encoding: 'utf8' }).stdout.trim()).toBe('1'));",
        ),
      },
      test: 'src/a.test.ts',
      edit: ['pkg/src/lib/v.mjs', 'export const v = 2;\n'],
    },
  };
  const MODES = { 'run F': (t: string) => ['run', t], run: () => ['run'] } as const;
  const real = (argv: string[], cwd = pkg) =>
    node(REAL_VITEST, argv, { NO_COLOR: '1', FORCE_COLOR: '0' }, cwd);

  it.each(
    Object.entries(SCENARIOS).flatMap(([name, s]) =>
      (Object.keys(MODES) as (keyof typeof MODES)[]).map((mode) => [name, mode, s] as const),
    ),
  )(
    '%s, %s — правка ломает тест, журнал красный',
    (_name, mode, s) => {
      initRepo(s.files);
      const argv = MODES[mode](s.test);
      const first = real(argv);
      expect(first.code, first.out + first.err).toBe(0);
      put(...s.edit);
      const second = real(argv);
      expect(second.code, second.out + second.err).toBe(1);
    },
    120_000,
  );

  it.each(Object.keys(MODES) as (keyof typeof MODES)[])(
    'cwd через junction, %s — граф по настоящему пути, журнал красный (R5)',
    (mode) => {
      initRepo(GRAPH);
      const link = join(root, 'link');
      symlinkSync(repo, link, 'junction');
      const cwd = join(link, 'pkg');
      const argv = MODES[mode]('src/a.test.ts');
      expect(real(argv, cwd).code).toBe(0);
      put('pkg/src/deep/x.ts', 'export const x = 2;\n');
      const second = real(argv, cwd);
      expect(second.err).toContain('[verify-ledger] delta since green');
      expect(second.code, second.out + second.err).toBe(1);
    },
    120_000,
  );

  it('правка, которой тест не видит, — сужение всё ещё сужает: ноль тестов, код 0', () => {
    initRepo({ ...GRAPH, 'pkg/src/other.ts': 'export const o = 1;\n' });
    real(['run', 'src/a.test.ts']);
    put('pkg/src/other.ts', 'export const o = 2;\n');
    const r = real(['run', 'src/a.test.ts']);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.err).toContain('[verify-ledger] delta since green');
    expect(r.out).toContain('No test files found');
  }, 120_000);
});
