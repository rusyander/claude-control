import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Прогоны блока Tests (`tools/qa/junit-run.mjs`, `tools/tests-cli.mjs run`) — настоящий
 * vitest с junit-отчётом, живой `--require` журнала и настоящий git во временной папке.
 * 19.10 журнал ни разу не повторил такой прогон: 43 промаха с причиной
 * `vitest --reporter=junit` за день — блок даёт новый временный путь отчёта каждый
 * раз, а отчёт читает файлом. Повтор обязан положить тот же отчёт по НОВОМУ пути.
 * Наивная реализация, на которой тест краснеет: junit-прогон как «не повторять».
 */
const PRELOAD = resolve(__dirname, '../../../../../tools/verify-ledger/preload.cjs').replace(
  /\\/g,
  '/',
);
/** Настоящий vitest этого пакета: копия ссылается на него, а не ставит свой. */
const VITEST = realpathSync(resolve(__dirname, '../../../node_modules/vitest'));

const TEST_FILE = `import { expect, it } from 'vitest';
it('[case-1] складывает', () => expect(1 + 1).toBe(2));
it('[case-2] вычитает', () => expect(3 - 1).toBe(2));
`;

let root: string;
let repo: string;
let home: string;

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

/** Один прогон в форме блока Tests; `shape` — junit-run или tests-cli. */
function run(report: string, shape: 'junit-run' | 'tests-cli') {
  const args =
    shape === 'junit-run'
      ? [
          'run',
          'sum.test.ts',
          '--coverage.enabled=false',
          '--reporter=junit',
          `--outputFile=${report}`,
        ]
      : [
          'run',
          '--reporter=default',
          '--reporter=junit',
          `--outputFile.junit=${report}`,
          'sum.test.ts',
        ];
  const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: `--require "${PRELOAD}"`,
      AGENTDECK_VERIFY_LEDGER_HOME: home,
      AGENTDECK_VERIFY_LEDGER: 'on',
      // Сам этот прогон может идти под журналом — вложенный vitest не должен знать о нём.
      VITEST: '',
      VITEST_POOL_ID: '',
      VITEST_WORKER_ID: '',
    },
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(`vitest ${r.status}: ${r.stdout}\n${r.stderr}`);
  return {
    reused: r.stderr.includes('[verify-ledger] reused green'),
    report: existsSync(report) ? readFileSync(report, 'utf8') : null,
  };
}

const cases = (xml: string | null) =>
  [...(xml ?? '').matchAll(/<testcase[^>]*name="([^"]+)"/g)].map((m) => m[1]);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-ledger-junit-'));
  repo = join(root, 'repo');
  home = join(root, 'home');
  mkdirSync(join(repo, 'node_modules'), { recursive: true });
  symlinkSync(VITEST, join(repo, 'node_modules', 'vitest'), 'junction');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'package.json'), '{"private":true,"type":"module"}\n');
  writeFileSync(join(repo, 'sum.test.ts'), TEST_FILE);
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'init');
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('verify-ledger: junit-прогоны блока Tests', () => {
  it.each(['junit-run', 'tests-cli'] as const)(
    'форма %s: второй прогон с новым путём отчёта — повтор, отчёт по новому пути тот же',
    (shape) => {
      const first = run(join(root, shape, 'r1', 'report.xml'), shape);
      expect(first.reused).toBe(false);
      expect(cases(first.report)).toEqual(['[case-1] складывает', '[case-2] вычитает']);
      const second = run(join(root, shape, 'r2', 'report.xml'), shape);
      expect(second.reused).toBe(true);
      expect(second.report).toBe(first.report);
    },
    240_000,
  );

  it('правка теста — прогон заново, отчёт свежий', () => {
    writeFileSync(
      join(repo, 'sum.test.ts'),
      `${TEST_FILE}it('[case-3] умножает', () => expect(2 * 2).toBe(4));\n`,
    );
    const fresh = run(join(root, 'edit', 'report.xml'), 'junit-run');
    expect(fresh.reused).toBe(false);
    expect(cases(fresh.report)).toContain('[case-3] умножает');
  }, 240_000);
});
