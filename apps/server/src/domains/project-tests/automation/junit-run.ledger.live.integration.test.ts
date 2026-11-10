import { execFileSync, spawnSync } from 'node:child_process';
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
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Настоящий `tools/qa/junit-run.mjs` над настоящим vitest под настоящим журналом проверок
 * (verify-ledger, preload из NODE_OPTIONS): живой набор (`*.live.*`) идёт заново каждый раз, а
 * обычный журнал вправе повторить по неизменному дереву.
 *
 * Зачем. 09.11.2026 `recorded.integration` дважды «прошёл» за 3 с вместо 24: журнал повторил
 * прошлый зелёный по тому же дереву, а запись → повтор по стенду и Chromium не шли вовсе.
 * Вердикт живого набора зависит от того, чего в дереве нет (стенд, браузер, CLI), — повтор
 * был бы зелёным без единой проверки.
 *
 * Счётчик запусков лежит вне дерева проекта: тест его не видит в отпечатке, видит только факт
 * запуска. Журнал — свой дом во временной папке (настоящий не трогается).
 */
const JUNIT_RUN = resolve(__dirname, '../../../../../../tools/qa/junit-run.mjs');
/** node_modules пакета целиком: `npx vitest` запускателя ищет свой .bin. */
const MODULES = resolve(__dirname, '../../../../node_modules');

/** Вход журнала из окружения этого процесса — замок снят: тест проверяет запускатель, не замок. */
function ledgerPreload(): string | undefined {
  const found = (process.env.NODE_OPTIONS ?? '').match(
    /--require\s+"?([^"\s]*verify-ledger[\\/]bin[\\/]preload(?:-locked)?\.cjs)"?/,
  )?.[1];
  const entry = found?.replace(/preload-locked\.cjs$/, 'preload.cjs');
  return entry && existsSync(entry) ? entry : undefined;
}

const automated = (id: string, file: string) => ({
  id,
  type: 'case',
  title: id,
  automation: { status: 'automated', file },
});

const temps: string[] = [];
afterAll(() => {
  for (const path of temps) {
    rmSync(join(path, 'node_modules'), { force: true, recursive: false });
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const temp = (prefix: string) => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temps.push(path);
  return path;
};

/** Тест, который дописывает строку в счётчик вне дерева: число строк = число настоящих запусков. */
const counting = (counter: string) =>
  "import { appendFileSync } from 'node:fs';\nimport { it } from 'vitest';\n" +
  `it('counts', () => { appendFileSync(${JSON.stringify(counter)}, 'run\\n'); });\n`;

const runs = (counter: string) =>
  existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0;

describe('junit-run under the verify ledger', { timeout: 180_000 }, () => {
  it('a live vitest file runs for real every time, while the ledger replays a plain file on the same tree', (ctx) => {
    const preload = ledgerPreload();
    if (!preload) {
      ctx.skip(true, 'Журнала проверок в NODE_OPTIONS нет — повторять некому, доказывать нечего.');
      return;
    }
    const root = temp('junit-run-ledger-');
    const outside = temp('junit-run-ledger-out-');
    const home = join(outside, 'ledger-home');
    mkdirSync(home);
    const liveCounter = join(outside, 'live.txt');
    const plainCounter = join(outside, 'plain.txt');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'node_modules\n');
    symlinkSync(MODULES, join(root, 'node_modules'), 'junction');
    writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'vitest.config.mjs'), 'export default { test: {} };\n');
    writeFileSync(join(root, 'pkg', 'stand.live.test.ts'), counting(liveCounter));
    writeFileSync(join(root, 'pkg', 'plain.test.ts'), counting(plainCounter));
    mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
    writeFileSync(
      join(root, '.agent', 'tests', 'g.tests.json'),
      JSON.stringify({
        id: 'g',
        cases: [automated('g-1', 'pkg/stand.live.test.ts'), automated('g-2', 'pkg/plain.test.ts')],
      }),
    );
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'm'], {
      cwd: root,
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_OPTIONS: `--require "${preload.split('\\').join('/')}"`,
      AGENTDECK_VERIFY_LEDGER_HOME: home,
    };
    for (const key of [
      'AGENTDECK_VERIFY_LEDGER',
      'AGENTDECK_VERIFY_LEDGER_LOCK',
      'AGENTDECK_TEST_CASES',
      'JUNIT_RUN_MAX_FAILURES',
      'JUNIT_RUN_HEALTH',
    ])
      delete env[key];
    const reports: string[] = [];
    for (const round of [1, 2]) {
      const out = join(outside, `junit-${round}.xml`);
      const run = spawnSync(
        process.execPath,
        [JUNIT_RUN, '--project', root, '--out', out, 'pkg/stand.live.test.ts', 'pkg/plain.test.ts'],
        { cwd: root, encoding: 'utf8', timeout: 150_000, env },
      );
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      reports.push(readFileSync(out, 'utf8'));
    }
    // Контроль: обычный файл журнал повторил — значит, журнал в этой обвязке жив и повторяет.
    if (runs(plainCounter) !== 1) {
      ctx.skip(
        true,
        `Журнал не повторил и обычный файл (запусков ${runs(plainCounter)}) — повтора нет, доказывать нечего.`,
      );
      return;
    }
    expect(runs(liveCounter)).toBe(2);
    for (const report of reports) {
      expect(report).toContain('[g-1]');
      expect(report).not.toContain('<failure');
      expect(report).not.toContain('<skipped');
    }
  });
});
