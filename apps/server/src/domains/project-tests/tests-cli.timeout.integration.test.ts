import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, parseCase, readGroups, writeGroup } from './store/store.ts';
import { readRuns } from './runs-store/runs-store.ts';

/**
 * Предел времени на кейс у `tests-cli run` (N2, журнал групп 23.10): повисший
 * кейс держал группу часами. Настоящий процесс `node tools/tests-cli.mjs` над
 * временным проектом, своя команда — спящий скрипт с ребёнком: снят ли весь
 * его дерево и что легло в историю.
 */
const CLI = resolve(__dirname, '../../../../../tools/tests-cli.mjs');
const ENV = 'AGENTDECK_TESTS_CASE_TIMEOUT';

/** Раннер, который не кончается: пишет свой номер и номер ребёнка и спит. */
const SLEEPER = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
writeFileSync('pids.json', JSON.stringify({ runner: process.pid, child: child.pid }));
setInterval(() => undefined, 1000);
`;

function cli(project: string, args: string[], env: Record<string, string> = {}) {
  const clean = { ...process.env };
  // Метки группы панели (короткий вывод, память, проект) у прогона теста — свои.
  delete clean[ENV];
  delete clean.AGENTDECK_BRIEF_OUTPUT;
  delete clean.AGENTDECK_TESTS_PROJECT;
  const started = Date.now();
  const result = spawnSync(process.execPath, [CLI, ...args, '--project', project], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...clean, ...env },
  });
  return {
    code: result.status,
    out: `${result.stdout}${result.stderr}`,
    seconds: (Date.now() - started) / 1000,
  };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function settled(pids: number[]): Promise<number[]> {
  const deadline = Date.now() + 5_000;
  let left = pids.filter(alive);
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
    left = left.filter(alive);
  }
  return left;
}

describe('tests-cli run: предел времени на кейс', () => {
  let project = '';
  let pids: { runner: number; child: number } | undefined;

  beforeEach(() => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-tests-cli-cap-')));
    writeFileSync(join(project, 'sleep.mjs'), SLEEPER);
    const group = (id: string, cases: Record<string, unknown>[]): void =>
      writeGroup(project, {
        ...createGroup(project, id, id),
        cases: cases.flatMap((raw, index) => parseCase(raw, index) ?? []),
      });
    const automated = (file: string) => ({ status: 'automated', file });
    group('qa', [
      { id: 'qa-001', title: 'панель @открывается', automation: automated('tools/qa/open.mjs') },
      { id: 'qa-002', title: 'поиск находит', automation: automated('tools/qa/search.mjs') },
    ]);
    group('other', [{ id: 'ot-001', title: 'чужое', automation: automated('tools/qa/other.mjs') }]);
    writeFileSync(
      join(project, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ version: 1, command: 'node sleep.mjs {files}' }),
    );
    pids = undefined;
  });

  afterEach(() => {
    // Провал проверки раньше чтения номеров не оставляет спящих: номера — из файла раннера.
    const file = join(project, 'pids.json');
    if (!pids && existsSync(file)) pids = JSON.parse(readFileSync(file, 'utf8'));
    for (const pid of pids ? [pids.child, pids.runner] : []) {
      try {
        process.kill(pid);
      } catch {
        // уже снят
      }
    }
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('повисший кейс: дерево снято, кейсы — проваленными с причиной, код 124', async () => {
    // 0,02 мин = 1,2 с на кейс × 2 файла группы = 2,4 с.
    const result = cli(project, ['run', '--group', 'qa'], { [ENV]: '0.02' });
    expect(result.out).toContain(`Предел: 0.02 мин на кейс × 2 = 0.04 мин (${ENV})`);
    expect(result.code).toBe(124);
    expect(result.seconds).toBeLessThan(30);
    pids = JSON.parse(readFileSync(join(project, 'pids.json'), 'utf8'));
    expect(await settled([pids!.runner, pids!.child])).toEqual([]);

    const [record] = readRuns(project);
    expect(record).toMatchObject({ exitCode: 124, summary: { failed: 2 } });
    expect(record?.scope).toContain('снят по пределу');
    expect(record?.results.map((point) => point.caseId).sort()).toEqual(['qa-001', 'qa-002']);
    for (const point of record?.results ?? []) {
      expect(point.status).toBe('failed');
      expect(point.note).toContain('Предел времени');
    }
    const qa = readGroups(project).find((g) => g.id === 'qa');
    expect(qa?.cases.map((item) => item.status)).toEqual(['failed', 'failed']);
    // Чужая группа прогоном не задета.
    const other = readGroups(project).find((g) => g.id === 'other');
    expect(other?.cases[0]?.status).not.toBe('failed');
  });

  it('--case-timeout сильнее переменной окружения', () => {
    const result = cli(project, ['run', '--case', 'qa:qa-002', '--case-timeout', '0.01'], {
      [ENV]: '30',
    });
    expect(result.out).toContain('Предел: 0.01 мин на кейс × 1 = 0.01 мин (--case-timeout)');
    expect(result.code).toBe(124);
    pids = JSON.parse(readFileSync(join(project, 'pids.json'), 'utf8'));
    expect(readRuns(project)[0]?.results.map((point) => point.caseId)).toEqual(['qa-002']);
  });

  it('по умолчанию — 10 мин на кейс; timeoutMinutes своей команды короче — он', () => {
    expect(cli(project, ['run', '--dry']).out).toContain(
      'Предел: 10 мин на кейс × 3 = 30 мин (по умолчанию)',
    );
    writeFileSync(
      join(project, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ version: 1, command: 'node sleep.mjs {files}', timeoutMinutes: 5 }),
    );
    expect(cli(project, ['run', '--dry']).out).toContain(
      'Предел: 5 мин (timeoutMinutes своей команды)',
    );
    expect(existsSync(join(project, 'pids.json'))).toBe(false);
  });

  // F-58: своя команда гонит весь набор, 10 мин × 1 файл снимали её получасовой прогон.
  it('timeoutMinutes своей команды длиннее произведения — он; --case-timeout сильнее него', () => {
    writeFileSync(
      join(project, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ version: 1, command: 'node sleep.mjs {files}', timeoutMinutes: 30 }),
    );
    expect(cli(project, ['run', '--case', 'qa:qa-002', '--dry']).out).toContain(
      'Предел: 30 мин (timeoutMinutes своей команды)',
    );
    expect(
      cli(project, ['run', '--case', 'qa:qa-002', '--case-timeout', '1', '--dry']).out,
    ).toContain('Предел: 1 мин на кейс × 1 = 1 мин (--case-timeout)');
  });

  // F-59: больше 2^31−1 мс setTimeout срабатывает через 1 мс — здоровый прогон снимался сразу.
  it('предел длиннее таймера Node — прогон идёт как обычно, без снятия и кода 124', () => {
    writeFileSync(join(project, 'quick.mjs'), 'process.exit(0);\n');
    writeFileSync(
      join(project, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ version: 1, command: 'node quick.mjs {files}' }),
    );
    const result = cli(project, ['run', '--case', 'qa:qa-002', '--case-timeout', '40000']);
    expect(result.out).toContain('= 35791.39 мин (--case-timeout; таймер дольше 35791.39 мин');
    expect(result.out).not.toContain('Прогон дольше предела');
    expect(result.code).not.toBe(124);
    expect(readRuns(project).some((record) => record.exitCode === 124)).toBe(false);
  });

  // F-66: фоновый внук с унаследованным выводом держал трубу короткого вывода,
  // и `run` ждал его жизнь целиком — и после выхода команды, и после предела.
  it('короткий вывод: фоновый внук держит трубу — run кончается с выходом команды', async () => {
    writeFileSync(
      join(project, 'detach.mjs'),
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 45000)'], { stdio: 'inherit', detached: true, cwd: tmpdir() });
child.unref();
writeFileSync('pids.json', JSON.stringify({ runner: process.pid, child: child.pid }));
`,
    );
    writeFileSync(
      join(project, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ version: 1, command: 'node detach.mjs {files}' }),
    );
    const result = cli(project, ['run', '--case', 'qa:qa-002', '--brief']);
    pids = JSON.parse(readFileSync(join(project, 'pids.json'), 'utf8'));
    // Внук живёт 45 с — снимаем его сами, прогон его не трогал.
    try {
      process.kill(pids!.child);
    } catch {
      // уже снят
    }
    await settled([pids!.child]);
    expect(result.seconds).toBeLessThan(30);
    expect(result.out).toContain('Команда завершилась с кодом 0');
  });

  // F-126: звено, дописавшее свой отчёт до предела, ложилось проваленным вместе с повисшим.
  it('снят по пределу: кейс, чей отчёт звено успело дописать, — своим итогом', async () => {
    writeFileSync(
      join(project, 'partial.mjs'),
      `import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('out', { recursive: true });
writeFileSync('out/open.xml', '<testsuites><testsuite name="open" tests="1"><testcase classname="tools/qa/open.mjs" name="[qa-001] панель открывается" time="0.1"/></testsuite></testsuites>');
const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
writeFileSync('pids.json', JSON.stringify({ runner: process.pid, child: child.pid }));
setInterval(() => undefined, 1000);
`,
    );
    writeFileSync(
      join(project, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ version: 1, command: 'node partial.mjs {files}', report: 'out/' }),
    );
    const result = cli(project, ['run', '--group', 'qa'], { [ENV]: '0.02' });
    expect(result.code).toBe(124);
    pids = JSON.parse(readFileSync(join(project, 'pids.json'), 'utf8'));
    expect(await settled([pids!.runner, pids!.child])).toEqual([]);
    const statuses = Object.fromEntries(
      (readRuns(project)[0]?.results ?? []).map((point) => [point.caseId, point.status]),
    );
    expect(statuses).toEqual({ 'qa-001': 'passed', 'qa-002': 'failed' });
  });

  it('негодный предел — отказ словами до прогона', () => {
    for (const value of ['0', '-1', 'abc']) {
      const result = cli(project, ['run', '--case-timeout', value]);
      expect(result.code).toBe(1);
      expect(result.out).toContain('--case-timeout ждёт минуты числом больше нуля');
    }
    expect(cli(project, ['run'], { [ENV]: 'x' }).out).toContain(`${ENV} ждёт минуты`);
    expect(existsSync(join(project, 'pids.json'))).toBe(false);
  });

  it('справка называет флаг, переменную и код 124', () => {
    const help = cli(project, ['help']).out;
    expect(help).toContain('--case-timeout <мин>');
    expect(help).toContain(ENV);
    expect(help).toContain('код 124');
  });
});
