import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Настоящий `tools/qa/junit-run.mjs` над настоящим vitest и node во временном проекте. 29.10.2026
 * параллельные зоны ядра гоняли кейсы, пока чужой mustfail подменял файлы дерева: `mutation-guard`
 * отказывал прогону, а запись кейса звала это провалом — история копила дефекты, которых нет.
 * Отказ стража — «не проверено» с его строкой; настоящий красный остаётся провалом.
 */
const JUNIT_RUN = resolve(__dirname, '../../../../../../tools/qa/junit-run.mjs');
/** node_modules пакета целиком: `npx vitest` запускателя ищет свой .bin. */
const MODULES = resolve(__dirname, '../../../../node_modules');

/** Строка отказа в том виде, в каком её бросает `tools/mutation-guard.mjs` из globalSetup. */
const GUARD =
  'mutation-guard: mustfail (pid 1234, начат 2026-10-29T00:00:00.000Z) прямо сейчас подменяет файлы этого дерева.';

const automated = (id: string, file: string) => ({
  id,
  type: 'case',
  title: id,
  automation: { status: 'automated', file },
});

let root: string;
let report: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'junit-run-busy-'));
  symlinkSync(MODULES, join(root, 'node_modules'), 'junction');
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  // Две папки vitest: страж в globalSetup одной (как в настоящих пакетах) и чистая вторая.
  for (const dir of ['busy', 'free']) mkdirSync(join(root, dir));
  writeFileSync(
    join(root, 'busy', 'vitest.config.mjs'),
    "export default { test: { globalSetup: ['./guard.mjs'] } };\n",
  );
  writeFileSync(
    join(root, 'busy', 'guard.mjs'),
    `export function setup() { throw new Error(${JSON.stringify(GUARD)}); }\n`,
  );
  writeFileSync(
    join(root, 'busy', 'a.test.ts'),
    "import { it } from 'vitest';\nit('a', () => {});\n",
  );
  writeFileSync(join(root, 'free', 'vitest.config.mjs'), 'export default { test: {} };\n');
  writeFileSync(
    join(root, 'free', 'red.test.ts'),
    "import { expect, it } from 'vitest';\nit('red', () => { expect(1).toBe(2); });\n",
  );
  writeFileSync(
    join(root, 'busy.mjs'),
    `console.error(${JSON.stringify(`Error: ${GUARD}`)});\nprocess.exit(1);\n`,
  );
  writeFileSync(join(root, 'fail.mjs'), "console.error('real failure');\nprocess.exit(1);\n");
  mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
  writeFileSync(
    join(root, '.agent', 'tests', 'g.tests.json'),
    JSON.stringify({
      id: 'g',
      cases: [
        automated('g-1', 'busy/a.test.ts'),
        automated('g-2', 'free/red.test.ts'),
        automated('g-3', 'busy.mjs'),
        automated('g-4', 'fail.mjs'),
      ],
    }),
  );
  const out = join(root, 'out', 'junit.xml');
  spawnSync(
    process.execPath,
    [
      JUNIT_RUN,
      '--project',
      root,
      '--out',
      out,
      'busy/a.test.ts',
      'free/red.test.ts',
      'busy.mjs',
      'fail.mjs',
    ],
    { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, NODE_OPTIONS: '' } },
  );
  report = readFileSync(out, 'utf8');
}, 150_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

function testcase(id: string) {
  return report.match(
    new RegExp(`<testcase [^>]*name="\\[${id}\\][^>]*>[\\s\\S]*?</testcase>`),
  )?.[0];
}

describe('junit-run: отказ mutation-guard — «не проверено», не провал', () => {
  it('vitest, чей globalSetup отказал стражем, — пропуск «Не проверено» со строкой стража', () => {
    const record = testcase('g-1') ?? '';
    expect(record).toContain('<skipped');
    expect(record).not.toContain('<failure');
    expect(record).toContain('Не проверено. mutation-guard: mustfail (pid 1234');
    expect(record).toContain('Повторите после конца mustfail.');
  });

  it('vitest с настоящим красным тестом на свободном дереве — провал', () => {
    const record = testcase('g-2') ?? '';
    expect(record).toContain('<failure');
    expect(record).not.toContain('Не проверено');
  });

  it('скрипт node, вышедший с кодом 1 со строкой стража, — пропуск «Не проверено»', () => {
    const record = testcase('g-3') ?? '';
    expect(record).toContain('<skipped');
    expect(record).toContain('Не проверено. Код выхода 1.');
  });

  it('скрипт node, вышедший с кодом 1 без строки стража, — провал', () => {
    const record = testcase('g-4') ?? '';
    expect(record).toContain('<failure');
    expect(record).not.toContain('Не проверено');
    expect(record).toContain('real failure');
  });
});
