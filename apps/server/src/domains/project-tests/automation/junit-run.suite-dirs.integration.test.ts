import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Настоящий `tools/qa/junit-run.mjs` над настоящим vitest во временном проекте: наборы-каталоги
 * одного пакета — один вызов vitest. 07.11.2026 кейсы `apps/core/` и `apps/core/src/` дали два
 * прогона всего пакета ядра (2 × 19 мин) и упёрлись в предел: корень, найденный от `apps/core/`,
 * хранил хвостовой разделитель, найденный от `apps/core/src/` — нет, и группы по корню разошлись.
 */
const JUNIT_RUN = resolve(__dirname, '../../../../../../tools/qa/junit-run.mjs');
/** node_modules пакета целиком: `npx vitest` запускателя ищет свой .bin. */
const MODULES = resolve(__dirname, '../../../../node_modules');

const automated = (id: string, file: string) => ({
  id,
  type: 'case',
  title: id,
  automation: { status: 'automated', file },
});

let root: string;
let report: string;
let stdout: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'junit-run-dirs-'));
  symlinkSync(MODULES, join(root, 'node_modules'), 'junction');
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  mkdirSync(join(root, 'pkg', 'src'), { recursive: true });
  writeFileSync(join(root, 'pkg', 'vitest.config.mjs'), 'export default { test: {} };\n');
  writeFileSync(
    join(root, 'pkg', 'root.test.ts'),
    "import { it } from 'vitest';\nit('root', () => {});\n",
  );
  writeFileSync(
    join(root, 'pkg', 'src', 'a.test.ts'),
    "import { it } from 'vitest';\nit('a', () => {});\n",
  );
  mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
  writeFileSync(
    join(root, '.agent', 'tests', 'g.tests.json'),
    JSON.stringify({ id: 'g', cases: [automated('g-1', 'pkg/'), automated('g-2', 'pkg/src/')] }),
  );
  const out = join(root, 'out', 'junit.xml');
  const run = spawnSync(
    process.execPath,
    [JUNIT_RUN, '--project', root, '--out', out, 'pkg/', 'pkg/src/'],
    { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, NODE_OPTIONS: '' } },
  );
  stdout = run.stdout ?? '';
  report = readFileSync(out, 'utf8');
}, 150_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Записи отчёта по файлу теста: `<testcase classname="pkg/root.test.ts" name="root" …>`. */
function testcases(file: string) {
  return report.match(new RegExp(`<testcase classname="${file}"[^>]*>[\\s\\S]*?</testcase>`, 'g'));
}

describe('junit-run: наборы-каталоги одного пакета', () => {
  it('корень пакета и его подкаталог — один вызов vitest, а не два', () => {
    expect(stdout.match(/▶ vitest/g) ?? []).toHaveLength(1);
  });

  it('каждый тест — в отчёте ровно раз и зелёный: и в корне пакета, и в подкаталоге', () => {
    for (const file of ['pkg/root.test.ts', 'pkg/src/a.test.ts']) {
      const records = testcases(file) ?? [];
      expect(records, file).toHaveLength(1);
      expect(records[0], file).not.toContain('<failure');
    }
  });
});
