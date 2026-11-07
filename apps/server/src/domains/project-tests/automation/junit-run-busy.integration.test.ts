import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Настоящий `tools/qa/junit-run.mjs` и настоящий `tools/mutation-guard.mjs` во временном git-проекте,
 * где «чужой mustfail» — журнал с pid живого процесса этого теста. 06.11 набор-каталог посреди
 * чужого mustfail лёг красным «нет ни одного теста», хотя тесты не запускались; файл рядом честно
 * выходил «не проверено».
 */
const JUNIT_RUN = resolve(__dirname, '../../../../../../tools/qa/junit-run.mjs');
const GUARD = resolve(__dirname, '../../../../../../tools/mutation-guard.mjs')
  .split('\\')
  .join('/');
/** node_modules пакета целиком: `npx vitest` запускателя ищет свой .bin. */
const MODULES = resolve(__dirname, '../../../../node_modules');

const TEST_FILE = `import { expect, it } from 'vitest';
it('проходит', () => expect(1 + 1).toBe(2));
`;

const automated = (id: string, file: string) => ({
  id,
  type: 'case',
  title: id,
  automation: { status: 'automated', file },
});

let root: string;
let run: ReturnType<typeof spawnSync>;
let report: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'junit-run-busy-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  symlinkSync(MODULES, join(root, 'node_modules'), 'junction');
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  writeFileSync(
    join(root, 'vitest.config.mjs'),
    `export default { test: { globalSetup: [${JSON.stringify(GUARD)}] } };\n`,
  );
  mkdirSync(join(root, 'suite'));
  writeFileSync(join(root, 'suite', 'a.test.ts'), TEST_FILE);
  writeFileSync(join(root, 'one.test.ts'), TEST_FILE);
  mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
  writeFileSync(
    join(root, '.agent', 'tests', 'g.tests.json'),
    JSON.stringify({
      id: 'g',
      cases: [automated('g-dir', 'suite/'), automated('g-file', 'one.test.ts')],
    }),
  );
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  const journalDir = join(root, '.git', 'mustfail');
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(
    join(journalDir, `journal-${process.pid}.json`),
    JSON.stringify({
      scope: top.stdout.trim().replace(/\\/g, '/').toLowerCase(),
      pid: process.pid,
      started: 'тест',
      files: {},
    }),
  );
  const out = join(root, 'out', 'junit.xml');
  run = spawnSync(
    process.execPath,
    [JUNIT_RUN, '--project', root, '--out', out, 'suite/', 'one.test.ts'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      // Свой pid mustfail снаружи сделал бы журнал «своим», и сторож пропустил бы прогон.
      env: { ...process.env, NODE_OPTIONS: '', MUSTFAIL_PID: '' },
    },
  );
  report = readFileSync(out, 'utf8');
}, 150_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `<testcase>` кейса по его `[id]` в имени. */
function testcase(id: string) {
  return report.match(
    new RegExp(`<testcase [^>]*name="\\[${id}\\][^>]*>[\\s\\S]*?</testcase>`),
  )?.[0];
}

describe('junit-run: чужой mustfail держит дерево', () => {
  it('кейс на каталог — «не проверено», а не провал', () => {
    const dir = testcase('g-dir');
    expect(dir).toContain('<skipped message="Не проверено. mutation-guard: mustfail');
    expect(dir).not.toContain('<failure');
  });

  it('кейс на файл — так же «не проверено»', () => {
    const file = testcase('g-file');
    expect(file).toContain('<skipped message="Не проверено. mutation-guard: mustfail');
    expect(file).not.toContain('<failure');
  });

  it('оба названы занятым стендом в выводе, провалов нет', () => {
    expect(String(run.stdout).match(/стенд занят мутантами — не проверено/g)).toHaveLength(2);
    expect(run.stdout).toContain('провалов 0');
  });
});
