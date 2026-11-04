import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Настоящий `tools/qa/junit-run.mjs`, которому корень проекта назван не в настоящем регистре
 * (`c:\…` вместо `C:\…`, короткое имя каталога `RUSYAN~1`). 03.11 кейсы kit-120/121 краснели только
 * под прогоном блока: скрипт получал cwd `c:\work\…`, его модули грузились по `c:/Users/…`, а сам он
 * сверял пути с os.homedir() (`C:\Users\…`). Теперь скрипт стартует в настоящем пути каталога.
 */
const JUNIT_RUN = resolve(__dirname, '../../../../../../tools/qa/junit-run.mjs');

/** Код 0, только если cwd скрипта уже в настоящем виде — регистр диска и длинные имена. */
const SCRIPT =
  `import { realpathSync } from 'node:fs';\n` +
  `const cwd = process.cwd();\n` +
  `process.exit(cwd === realpathSync.native(cwd) ? 0 : 1);\n`;

/** Тот же каталог другим написанием: на Windows — диск в другом регистре. */
const respelled = (dir: string) => {
  const drive = dir.charAt(0);
  if (!/^[a-z]:/i.test(dir)) return dir;
  return (drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()) + dir.slice(1);
};

let root: string;
let report: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'junit-run-case-'));
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  writeFileSync(join(root, 'check.mjs'), SCRIPT);
  mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
  writeFileSync(
    join(root, '.agent', 'tests', 'g.tests.json'),
    JSON.stringify({
      id: 'g',
      cases: [
        {
          id: 'g-1',
          type: 'case',
          title: 'g-1',
          automation: { status: 'automated', file: 'check.mjs' },
        },
      ],
    }),
  );
  const out = join(root, 'out', 'junit.xml');
  const inherited: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
  delete inherited.AGENTDECK_TEST_CASES;
  spawnSync(
    process.execPath,
    [JUNIT_RUN, '--project', respelled(root), '--out', out, 'check.mjs'],
    { cwd: root, encoding: 'utf8', timeout: 60_000, env: inherited },
  );
  report = readFileSync(out, 'utf8');
}, 90_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('junit-run: корень проекта в настоящем написании', () => {
  it.runIf(process.platform === 'win32')(
    'скрипт, которому корень назван с диском в другом регистре, стартует в настоящем пути',
    () => {
      expect(respelled(root)).not.toBe(realpathSync.native(root));
      const testcase = report.match(
        /<testcase [^>]*name="\[g-1\][^>]*(?:\/>|>[\s\S]*?<\/testcase>)/,
      )?.[0];
      expect(testcase).toBeDefined();
      expect(testcase).not.toMatch(/<failure/);
    },
  );
});
