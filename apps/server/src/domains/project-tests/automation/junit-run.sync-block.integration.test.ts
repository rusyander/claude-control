import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Настоящий `tools/qa/junit-run.mjs` над настоящим vitest во временном проекте. 24.10.2026 группа
 * трижды гоняла файл, чей тест держал поток синхронно: vitest пишет «Test timed out in 1000ms»,
 * хотя тест шёл в разы дольше, — по такой записи провал читается как медленный стенд, и его
 * повторяют. Запись кейса должна назвать синхронную блокировку, а обычный асинхронный срок — нет.
 */
const JUNIT_RUN = resolve(__dirname, '../../../../../../tools/qa/junit-run.mjs');
/** node_modules пакета целиком: `npx vitest` запускателя ищет свой .bin. */
const MODULES = resolve(__dirname, '../../../../node_modules');

const TEST_FILE = `import { it } from 'vitest';
const hold = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
it('держит поток', () => {
  hold(2500);
});
it('ждёт асинхронно', async () => {
  await new Promise((done) => setTimeout(done, 5000));
});
`;

const automated = (id: string, testName: string) => ({
  id,
  type: 'case',
  title: id,
  automation: { status: 'automated', file: 'block.test.ts', testName },
});

let root: string;
let report: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'junit-run-sync-'));
  symlinkSync(MODULES, join(root, 'node_modules'), 'junction');
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  writeFileSync(
    join(root, 'vitest.config.mjs'),
    'export default { test: { testTimeout: 1000 } };\n',
  );
  writeFileSync(join(root, 'block.test.ts'), TEST_FILE);
  mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
  writeFileSync(
    join(root, '.agent', 'tests', 'g.tests.json'),
    JSON.stringify({
      id: 'g',
      cases: [automated('g-1', 'держит поток'), automated('g-2', 'ждёт асинхронно')],
    }),
  );
  const out = join(root, 'out', 'junit.xml');
  spawnSync(process.execPath, [JUNIT_RUN, '--project', root, '--out', out, 'block.test.ts'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  report = readFileSync(out, 'utf8');
}, 150_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

function testcase(id: string) {
  return report.match(
    new RegExp(`<testcase [^>]*name="\\[${id}\\][^>]*>[\\s\\S]*?</testcase>`),
  )?.[0];
}

describe('junit-run: синхронная блокировка теста vitest', () => {
  it('тест, державший поток вдвое дольше предела, — провал с причиной «синхронная блокировка»', () => {
    const record = testcase('g-1') ?? '';
    expect(record).toContain('<failure');
    expect(record).toContain('Синхронная блокировка');
    expect(record).toMatch(/при пределе 1 с/);
  });

  it('асинхронный тест, снятый своим сроком, — обычный провал без этой причины', () => {
    const record = testcase('g-2') ?? '';
    expect(record).toContain('<failure');
    expect(record).toContain('timed out');
    expect(record).not.toContain('Синхронная блокировка');
  });
});
