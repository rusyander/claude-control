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

/**
 * Код 0 только с `--ok`: по коду выхода видно, дошли ли аргументы кейса до скрипта. И только без
 * `AGENTDECK_TEST_CASES`: выбор кейсов — самому junit-run, его дети списка не наследуют.
 */
const SCRIPT =
  `const ok = process.argv.slice(2).join(' ') === '--ok --topic core';\n` +
  `process.exit(ok && !process.env.AGENTDECK_TEST_CASES ? 0 : 1);\n`;

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
  // Без выбора: внешний прогон мог оставить свой список, и временная библиотека его не знает.
  const inherited: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
  delete inherited.AGENTDECK_TEST_CASES;
  run = spawnSync(process.execPath, [JUNIT_RUN, '--project', root, '--out', out, 'check.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: inherited,
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

  // 02.11: `tests-cli run --case` двух кейсов `check-core-chat.mjs` гонял все пять его запусков,
  // упирался в предел 10 мин и клал оба кейса проваленными (прогон 3deb1cb9).
  it('выбор в AGENTDECK_TEST_CASES — запускаются только выбранные кейсы файла', () => {
    const out = join(root, 'out', 'picked.xml');
    const picked = spawnSync(
      process.execPath,
      [JUNIT_RUN, '--project', root, '--out', out, 'check.mjs'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, NODE_OPTIONS: '', AGENTDECK_TEST_CASES: 'g:g-1, other:g-3' },
      },
    );
    const xml = readFileSync(out, 'utf8');
    expect(xml).toMatch(/name="\[g-1\]/);
    expect(xml).not.toMatch(/\[g-2\]|\[g-3\]/);
    // Выбор не утёк в окружение скрипта (прогон 717df261: вложенный junit-run терял свои кейсы).
    expect(xml).not.toMatch(/<failure/);
    expect(String(picked.stdout)).not.toMatch(/▶ node check\.mjs\r?\n/);
    expect(picked.status).toBe(0);
  }, 90_000);
});

// 04.11: core-chat-012 краснел только под `tests-cli`, а в истории лежали одни имена проверок —
// подробность (`check(name, ok, detail)` стенда пишет её строкой ниже) терялась.
describe('junit-run: подробность провала под строкой ✗ доходит до кейса', () => {
  it('строка глубже отступом под ✗ — в сообщении провала; строка того же уровня — нет', () => {
    const dir = mkdtempSync(join(tmpdir(), 'junit-run-detail-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"private":true,"type":"module"}\n');
      writeFileSync(
        join(dir, 'detail.mjs'),
        [
          `console.log('  ✓ прошла');`,
          `console.log('  ✗ кнопка сняла задачу');`,
          `console.log('    кнопка видна, нажата: false');`,
          `console.log('  ✓ соседняя строка');`,
          `process.exit(1);`,
        ].join('\n'),
      );
      mkdirSync(join(dir, '.agent', 'tests'), { recursive: true });
      writeFileSync(
        join(dir, '.agent', 'tests', 'd.tests.json'),
        JSON.stringify({
          id: 'd',
          cases: [
            {
              id: 'd-1',
              type: 'case',
              title: 'd-1',
              automation: { status: 'automated', file: 'detail.mjs' },
            },
          ],
        }),
      );
      const out = join(dir, 'out', 'junit.xml');
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
      delete env.AGENTDECK_TEST_CASES;
      spawnSync(process.execPath, [JUNIT_RUN, '--project', dir, '--out', out, 'detail.mjs'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env,
      });
      // Тело `<failure>` — полный текст провала (атрибут message — только первая строка); из
      // него импорт кладёт заметку кейса в историю.
      const failure =
        /<failure [^>]*>([\s\S]*?)<\/failure>/.exec(readFileSync(out, 'utf8'))?.[1] ?? '';
      expect(failure).toContain('кнопка сняла задачу');
      expect(failure).toContain('кнопка видна, нажата: false');
      expect(failure).not.toContain('соседняя строка');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
