import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Настоящий `tools/qa/junit-run.mjs` над скриптом-проверкой во временном проекте. 01.11 кейс темы
 * справки «Ядро» не мог проверить только свою тему: запускатель звал скрипт без аргументов, и кейс
 * краснел от отставания чужих тем. Теперь `automation.testName` скрипта — его аргументы.
 */
const JUNIT_RUN = resolve(__dirname, '../../../../../../tools/qa/junit-run.mjs');

/** Код 0 только с `--ok`: по коду выхода видно, дошли ли аргументы кейса до скрипта. */
const SCRIPT = `process.exit(process.argv.slice(2).join(' ') === '--ok --topic core' ? 0 : 1);\n`;

const scripted = (id: string, testName?: string) => ({
  id,
  type: 'case',
  title: id,
  automation: { status: 'automated', file: 'check.mjs', ...(testName ? { testName } : {}) },
});

let root: string;
let run: ReturnType<typeof spawnSync>;
let report: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'junit-run-args-'));
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  writeFileSync(join(root, 'check.mjs'), SCRIPT);
  mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
  writeFileSync(
    join(root, '.agent', 'tests', 'g.tests.json'),
    JSON.stringify({
      id: 'g',
      cases: [
        scripted('g-1', '--ok --topic core'),
        scripted('g-2', ' --ok  --topic core '),
        scripted('g-3'),
      ],
    }),
  );
  const out = join(root, 'out', 'junit.xml');
  run = spawnSync(process.execPath, [JUNIT_RUN, '--project', root, '--out', out, 'check.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  report = readFileSync(out, 'utf8');
}, 90_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

function testcase(id: string) {
  return report.match(
    new RegExp(
      `<testcase [^>]*name="\\[${id}\\][^>]*>[\\s\\S]*?</testcase>|<testcase [^>]*name="\\[${id}\\][^>]*/>`,
    ),
  )?.[0];
}

describe('junit-run: аргументы скрипта из automation.testName', () => {
  it('кейс с аргументами получает их и проходит; те же аргументы с лишними пробелами — один запуск', () => {
    expect(testcase('g-1')).toBeDefined();
    expect(testcase('g-1')).not.toMatch(/<failure/);
    expect(testcase('g-2')).not.toMatch(/<failure/);
    expect(String(run.stdout).match(/▶ node check\.mjs --ok --topic core/g)).toHaveLength(1);
  });

  it('кейс без testName запускает скрипт без аргументов, как раньше, и краснеет по коду выхода', () => {
    expect(testcase('g-3')).toMatch(/<failure/);
    expect(String(run.stdout)).toMatch(/▶ node check\.mjs\r?\n/);
    expect(run.status).toBe(1);
  });
});
