import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Настоящий `tools/qa/junit-run.mjs` над настоящим vitest во временном проекте. 25.10 тест гонки,
 * пропустивший себя сам (`ctx.skip()`), шёл в счёт «не засчитано из-за стенда» и давал код 1
 * зелёному прогону, а кейс на блок describe, где пропущено всё, выходил зелёным без единой проверки.
 */
const JUNIT_RUN = resolve(__dirname, '../../../../../../tools/qa/junit-run.mjs');
/** node_modules пакета целиком: `npx vitest` запускателя ищет свой .bin. */
const MODULES = resolve(__dirname, '../../../../node_modules');

const TEST_FILE = `import { describe, expect, it } from 'vitest';
describe('блок', () => {
  it('сам пропускает', (ctx) => {
    ctx.skip();
  });
  it.skip('пропущен автором', () => {});
});
it('проходит', () => expect(1 + 1).toBe(2));
`;

const automated = (id: string, testName: string) => ({
  id,
  type: 'case',
  title: id,
  automation: { status: 'automated', file: 'skip.test.ts', testName },
});

let root: string;
let run: ReturnType<typeof spawnSync>;
let report: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'junit-run-skip-'));
  symlinkSync(MODULES, join(root, 'node_modules'), 'junction');
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  writeFileSync(join(root, 'vitest.config.mjs'), 'export default {};\n');
  writeFileSync(join(root, 'skip.test.ts'), TEST_FILE);
  mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
  writeFileSync(
    join(root, '.agent', 'tests', 'g.tests.json'),
    JSON.stringify({
      id: 'g',
      cases: [
        automated('g-1', 'блок > сам пропускает'),
        automated('g-2', 'блок'),
        automated('g-3', 'проходит'),
      ],
    }),
  );
  const out = join(root, 'out', 'junit.xml');
  run = spawnSync(process.execPath, [JUNIT_RUN, '--project', root, '--out', out, 'skip.test.ts'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    // Журнал проверок панели здесь лишний: прогон должен идти, а не повторяться из журнала.
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  report = readFileSync(out, 'utf8');
}, 150_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `<testcase>` кейса по его `[id]` в имени. */
function testcase(id: string) {
  return report.match(
    new RegExp(`<testcase [^>]*name="\\[${id}\\][^>]*>[\\s\\S]*?</testcase>`),
  )?.[0];
}

describe('junit-run: пропуск, который решил сам тест', () => {
  it('ctx.skip() и it.skip — «пропущено самими тестами», стенд ни при чём, код 0', () => {
    expect(run.stdout).toContain('не засчитано из-за стенда 0');
    expect(run.stdout).toContain('пропущено самими тестами 2');
    expect(run.status).toBe(0);
  });

  it('кейс на тест, пропустивший себя, — skipped с причиной', () => {
    expect(testcase('g-1')).toContain(
      '<skipped message="Пропущен самим тестом (it.skip или ctx.skip()).">',
    );
  });

  it('кейс на блок describe, где пропущены все тесты, — skipped, а не зелёный', () => {
    expect(testcase('g-2')).toContain('<skipped');
  });

  it('кейс на прошедший тест рядом — зелёный', () => {
    expect(testcase('g-3')).toBeDefined();
    expect(testcase('g-3')).not.toContain('<skipped');
    expect(testcase('g-3')).not.toContain('<failure');
  });
});
