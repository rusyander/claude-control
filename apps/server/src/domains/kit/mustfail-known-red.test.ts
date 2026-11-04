import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * `tools/mustfail.mjs` набора, когда проверка красная ещё до отката (тест, которому нужен remote или
 * соседняя копия): раннер, называющий упавшие тесты, задаёт известный красный набор, и откат — RED только
 * по новому падению. Плюс `node --test` как подбор тестов, RED по дереву при любой команде и база из
 * памяти при повторе. Доказательство — CLI над одноразовым репозиторием, без моков.
 */

// AGENTDECK_KIT_UNDER_TEST — копия набора для прогона «красный до» против старого кода; без неё — встроенный.
const MUSTFAIL = join(
  process.env.AGENTDECK_KIT_UNDER_TEST || builtinKitDir(),
  'tools',
  'mustfail.mjs',
);
const repos: string[] = [];
afterAll(() => {
  for (const d of repos) rmSync(d, { recursive: true, force: true });
});

const WORK = 'module.exports = () => 2; // uncommitted work\n';
function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-mustfail-known-')));
  repos.push(dir);
  const git = (...a: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a],
      { cwd: dir, encoding: 'utf8' },
    );
  const write = (rel: string, text: string) => writeFileSync(join(dir, rel), text);
  const read = (rel: string) => readFileSync(join(dir, rel), 'utf8');
  git('init', '-q');
  for (const f of ['a.js', 'b.js', 'c.js']) write(f, 'module.exports = () => 1;\n');
  // Проверка знает только a.js и ждёт ИЗМЕНЁННОГО поведения.
  write(
    'check.cjs',
    "require('fs').appendFileSync(__dirname + '/runs.log', 'x');\nif (require('./a.js')() !== 2) process.exit(1);\n",
  );
  write('.gitignore', 'runs.log\nunrelated.log\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { dir, git, write, read };
}
type Repo = ReturnType<typeof repo>;
const work = (r: Repo) => ['a.js', 'b.js', 'c.js'].forEach((f) => r.write(f, WORK));
const intact = (r: Repo) => ['a.js', 'b.js', 'c.js'].every((f) => r.read(f) === WORK);
const run = (r: Repo, ...args: string[]) => {
  const p = spawnSync(process.execPath, [MUSTFAIL, '--cwd', r.dir, '--base', 'HEAD', ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENTDECK_VERIFY_LEDGER: 'off', AGENTDECK_VERIFY_LEDGER_LOCK: '' },
  });
  return { status: p.status, out: `${p.stdout}${p.stderr}` };
};
const row = (out: string, file: string) =>
  out.split('\n').find((l) => l.startsWith(`| ${file}`)) ?? '';

describe('mustfail набора: известная красная база', () => {
  it('проверка красная до отката и называет упавший тест: прогон идёт, RED только по новому падению', () => {
    const r = repo();
    r.write(
      'tap.cjs',
      "let bad = 0;\nconsole.log('not ok 1 - needs a remote'); bad++;\n" +
        "if (require('./a.js')() !== 2) { console.log('not ok 2 - a returns 2'); bad++; }\nprocess.exit(bad ? 1 : 0);\n",
    );
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'tap');
    work(r);
    const v = run(r, '--cmd', 'node tap.cjs', '--files', 'a.js,b.js');
    expect(v.status, v.out).not.toBe(2);
    expect(v.out).toMatch(/the baseline is red before any revert — 1 test\(s\): needs a remote/);
    expect(row(v.out, 'a.js')).toMatch(/\bRED\b/);
    expect(row(v.out, 'b.js')).toMatch(/GREEN.*beyond those failing before it/);
    expect(intact(r)).toBe(true);
  });

  it('{file}-команда: своя красная база по файлу — RED за новое падение, GREEN вместо NO-BASE', () => {
    const r = repo();
    r.write(
      'tapone.cjs',
      "const f = process.argv[2];\nconsole.log('not ok 1 - needs a remote');\n" +
        "if (f === 'a.js' && require('./a.js')() !== 2) console.log('not ok 2 - a returns 2');\nprocess.exit(1);\n",
    );
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'tap');
    work(r);
    const t = run(r, '--cmd', 'node tapone.cjs {file}', '--files', 'a.js,b.js', '--fresh');
    expect(row(t.out, 'a.js'), t.out).toMatch(/\bRED\b/);
    expect(row(t.out, 'b.js'), t.out).toMatch(/GREEN/);
    expect(t.out).not.toMatch(/NO-BASE/);
    expect(intact(r)).toBe(true);
  });

  it('красная база, не называющая тестов, по-прежнему останавливает прогон — exit 2', () => {
    const r = repo();
    r.write('mute.cjs', 'process.exit(1);\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'mute');
    work(r);
    const v = run(r, '--cmd', 'node mute.cjs', '--files', 'a.js,b.js');
    expect(v.status, v.out).toBe(2);
    expect(v.out).toMatch(/names no failing test/);
    expect(intact(r)).toBe(true);
  });
});

describe('mustfail набора: RED по дереву при любой команде', () => {
  it('другая строка --cmd на том же дереве берёт доказанный RED из памяти без прогона; правка — прогон заново', () => {
    const r = repo();
    work(r);
    run(r, '--cmd', 'node check.cjs', '--files', 'a.js');
    const before = r.read('runs.log').length;
    const v = run(r, '--cmd', 'node  check.cjs', '--files', 'a.js');
    expect(row(v.out, 'a.js'), v.out).toMatch(/RED.*same tree, another command/);
    expect(r.read('runs.log').length).toBe(before);
    r.write('a.js', 'module.exports = () => 2; // edited again\n');
    const w = run(r, '--cmd', 'node  check.cjs', '--files', 'a.js');
    expect(row(w.out, 'a.js')).not.toMatch(/same tree/);
    expect(row(w.out, 'a.js')).toMatch(/\bRED\b/);
  });
});

describe('mustfail набора: node --test как подбор тестов', () => {
  const t = (name: string, body: string) =>
    "import test from 'node:test';\nimport assert from 'node:assert';\nimport { createRequire } from 'node:module';\n" +
    `const require = createRequire(import.meta.url);\ntest('${name}', () => { ${body} });\n`;

  it('каждый файл гоняет только свой тест, красный по окружению тест — известная база, повтор берёт базу из памяти', () => {
    const r = repo();
    // Красный по окружению тест сидит ВНУТРИ покрывающего файла.
    r.write(
      'a.test.mjs',
      t('a returns 2', "assert.equal(require('./a.js')(), 2);") +
        "test('needs a remote', () => { assert.fail('no remote'); });\n",
    );
    r.write('b.test.mjs', t('b loads', "require('./b.js');"));
    r.write('z.test.mjs', t('unrelated', "require('fs').appendFileSync('unrelated.log', 'x');"));
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'tests');
    work(r);
    const v = run(
      r,
      '--cmd',
      'node --test a.test.mjs b.test.mjs z.test.mjs',
      '--files',
      'a.js,b.js',
    );
    expect(v.out).toMatch(/a\.js ← own test: a\.test\.mjs/);
    expect(existsSync(join(r.dir, 'unrelated.log'))).toBe(false);
    expect(v.status, v.out).not.toBe(2);
    expect(v.out).toMatch(/the baseline is red before any revert/);
    expect(row(v.out, 'a.js')).toMatch(/\bRED\b/);
    expect(row(v.out, 'b.js')).toMatch(/GREEN/);
    expect(intact(r)).toBe(true);

    const again = run(r, '--cmd', 'node --test b.test.mjs', '--files', 'b.js');
    expect(again.out).toMatch(/baseline from the memo/);
    expect(row(again.out, 'b.js')).toMatch(/GREEN/);
    r.write('b.js', 'module.exports = () => 2; // touched\n');
    const moved = run(r, '--cmd', 'node --test b.test.mjs', '--files', 'b.js');
    expect(moved.out).not.toMatch(/baseline from the memo/);
  });
});
