import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, parseCase, writeGroup } from './store/store.ts';
import { readRuns } from './runs-store/runs-store.ts';
import { CHECK_MEMO } from './check-memo/check-memo.ts';

/**
 * Память проверок (9.3) через настоящий `tests-cli run`: репозиторий git,
 * своя команда проекта, импорт и история. Раннер считает свои запуски в
 * `.agent/` — вне отпечатка, как и история, которую пишет сам прогон.
 */
const CLI = resolve(__dirname, '../../../../../tools/tests-cli.mjs');

const RUNNER = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const count = existsSync('.agent/count') ? Number(readFileSync('.agent/count', 'utf8')) : 0;
writeFileSync('.agent/count', String(count + 1));
const red = readFileSync('src.ts', 'utf8').includes('red');
writeFileSync(process.env.AGENTDECK_JUNIT_REPORT, '<testsuites><testsuite name="qa">' +
  '<testcase name="[qa-001] панель открывается" classname="qa">' +
  (red ? '<failure message="нет"/>' : '') + '</testcase></testsuite></testsuites>');
process.exit(red ? 1 : 0);
`;

describe('tests-cli run: память зелёного прогона', () => {
  let project = '';

  const git = (...args: string[]): void => {
    spawnSync('git', ['-c', 'user.email=x@y', '-c', 'user.name=x', ...args], { cwd: project });
  };
  const run = (env: Record<string, string>, ...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, 'run', ...args, '--project', project], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, AGENTDECK_BRIEF_OUTPUT: '', ...env },
    });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  };
  const group = { AGENTDECK_BRIEF_OUTPUT: '1' };
  const count = (): number => Number(readFileSync(join(project, '.agent', 'count'), 'utf8'));

  beforeEach(() => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-tests-cli-memo-')));
    writeFileSync(join(project, 'run.mjs'), RUNNER);
    writeFileSync(join(project, 'src.ts'), 'export const ok = 1;\n');
    writeGroup(project, {
      ...createGroup(project, 'qa', 'qa'),
      cases: [
        parseCase(
          {
            id: 'qa-001',
            title: 'панель открывается',
            automation: { status: 'automated', file: 'tools/qa/open.mjs' },
          },
          0,
        ),
      ].flatMap((item) => item ?? []),
    });
    writeFileSync(
      join(project, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ version: 1, command: 'node run.mjs {files}' }),
    );
    git('init', '-q', '-b', 'main');
    git('add', 'run.mjs', 'src.ts');
    git('commit', '-qm', 'init');
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('группе: зелёный на том же дереве — из памяти, без прогона, своей записью истории', () => {
    expect(run(group).code).toBe(0);
    const [first] = readRuns(project);

    const again = run(group);

    expect(again.code).toBe(0);
    expect(again.out).toContain(`Без изменений с зелёного прогона ${first?.id}`);
    expect(count()).toBe(1);
    // Ответ памяти — в истории (ревью B2-F4): проверка конца хода ждёт прогона
    // после правки и без записи гоняла бы агента по кругу.
    // Обе записи ложатся в одну секунду: порядок файлов тогда — по случайному ключу.
    const runs = readRuns(project);
    expect(runs.map((item) => item.id)).toContain(first?.id);
    const replay = runs.find((item) => item.id !== first?.id);
    expect(runs).toHaveLength(2);
    expect(replay?.scope).toContain(`из памяти ${first?.id}`);
    expect(replay?.results).toEqual(first?.results);
    expect(Date.parse(replay?.startedAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(first?.startedAt ?? ''),
    );
    expect(again.out).toContain(`записан в историю как ${replay?.id}`);
    // Память лежит в папке, спрятанной от git самой собой.
    expect(existsSync(join(project, CHECK_MEMO))).toBe(true);
  });

  it('запись зелёного прогона вытеснена — прогон настоящий', () => {
    run(group);
    const runsDir = join(project, '.agent', 'tests', 'runs');
    for (const name of readdirSync(runsDir)) rmSync(join(runsDir, name));
    expect(run(group).out).not.toContain('Без изменений');
    expect(count()).toBe(2);
  });

  it('своя команда по стенду (адрес, проверка здоровья) памяти не подлежит', () => {
    writeFileSync(
      join(project, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ version: 1, command: 'node run.mjs --health http://127.0.0.1:1 {files}' }),
    );
    run(group);
    expect(run(group).out).not.toContain('Без изменений');
    expect(count()).toBe(2);
  });

  it('правка файла, --fresh и прогон без метки группы идут по-настоящему', () => {
    run(group);
    run(group, '--fresh');
    expect(count()).toBe(2);

    writeFileSync(join(project, 'src.ts'), 'export const ok = 2;\n');
    expect(run(group).out).not.toContain('Без изменений');
    expect(count()).toBe(3);

    run({});
    run({});
    expect(count()).toBe(5);
    // По --memo память включается и человеку: зелёный группы на этом дереве ещё в силе.
    expect(run({}, '--memo').out).toContain('Без изменений');
    expect(count()).toBe(5);
  });

  /** Ревью B2-F15: код 0 без единого результата — не «зелёный», помнить нечего. */
  it('код 0 без результатов не запоминается', () => {
    writeFileSync(
      join(project, 'run.mjs'),
      RUNNER.replace(
        /writeFileSync\(process\.env\.AGENTDECK_JUNIT_REPORT[\s\S]*?\);\n/,
        "writeFileSync(process.env.AGENTDECK_JUNIT_REPORT, '<testsuites></testsuites>');\n",
      ),
    );
    run(group);
    expect(run(group).out).not.toContain('Без изменений');
    expect(count()).toBe(2);
  });

  it('красный не запоминается и снимает прежний зелёный', () => {
    run(group);
    writeFileSync(join(project, 'src.ts'), 'export const red = 1;\n');
    expect(run(group).code).toBe(1);
    expect(run(group).code).toBe(1);
    expect(count()).toBe(3);

    // Вернули зелёное содержимое — памяти о нём уже нет: прогон снова настоящий.
    writeFileSync(join(project, 'src.ts'), 'export const ok = 1;\n');
    expect(run(group).out).not.toContain('Без изменений');
    expect(count()).toBe(4);
  });
});
