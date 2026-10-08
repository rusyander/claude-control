import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, readGroups, upsertCase } from './store/store.ts';
import { readRuns } from './runs-store/runs-store.ts';

/**
 * `case` и `record` — команды, которыми агент чата пишет в блок «Тесты» (Ф17,
 * Ф18), через сам процесс `node tools/tests-cli.mjs`: разбор аргументов —
 * часть того, что проверяется, и модульный тест домена его не видит.
 *
 * - Ф17: значение опции, начинающееся с `--`, — отказ с именем опции, а не
 *   тихо проглоченный флаг (`--note --x` раньше терял заметку).
 * - Ф18: `case --file` вне проекта — отказ: такой кейс потом гоняется без
 *   присмотра, а файл читался бы из любого места диска.
 */
const CLI = resolve(__dirname, '../../../../../tools/tests-cli.mjs');

function cli(project: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--project', project], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('tests-cli case / record', () => {
  let root = '';
  let project = '';
  const now = '2026-09-20T10:00:00.000Z';

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-tests-cli-agent-')));
    project = join(root, 'proj');
    mkdirSync(project);
    createGroup(project, 'gui', 'GUI');
    upsertCase(project, 'gui', { title: 'Вход', steps: ['открыть'] }, now);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const titles = () => readGroups(project)[0]?.cases.map((item) => item.title);

  it('case --json заводит кейс, record пишет прогон с заметкой', () => {
    const created = cli(project, 'case', '--group', 'gui', '--json', '{"title":"Выход"}');
    expect(created.code, created.out).toBe(0);
    expect(created.out).toContain('Заведён кейс gui:gui-002');
    expect(titles()).toEqual(['Вход', 'Выход']);

    const recorded = cli(project, 'record', 'gui:gui-001=passed', '--note', 'проверен вход');
    expect(recorded.code, recorded.out).toBe(0);
    const [run] = readRuns(project);
    expect(run?.results).toEqual([
      expect.objectContaining({ caseId: 'gui-001', status: 'passed', note: 'проверен вход' }),
    ]);
  });

  it('record с красным результатом — код 1', () => {
    const recorded = cli(project, 'record', 'gui:gui-001=failed');
    expect(recorded.code).toBe(1);
    expect(recorded.out).toContain('красных 1');
  });

  it('Ф17: --note со следующим флагом вместо текста — отказ, прогон не записан', () => {
    const recorded = cli(project, 'record', 'gui:gui-001=passed', '--note', '--group', 'gui');
    expect(recorded.code).toBe(1);
    expect(recorded.out).toContain('--note ждёт значение');
    expect(readRuns(project)).toEqual([]);
  });

  it('Ф17: опция без значения в конце — отказ с её именем', () => {
    // `--project` дописывает `cli`, поэтому пустой хвост — у `--group`.
    const result = spawnSync(process.execPath, [CLI, 'case', '--project', project, '--group'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('--group ждёт значение');
  });

  it('Ф17: флаги без значения (--dry, --save, --help) по-прежнему флаги', () => {
    const help = cli(project, 'help', '--help');
    expect(help.code, help.out).toBe(0);
    expect(help.out).toContain('Тест-кейсы проекта без панели.');
  });

  it('case --file внутри проекта читается', () => {
    mkdirSync(join(project, 'cases'));
    writeFileSync(join(project, 'cases', 'exit.json'), '{"title":"Выход"}');
    const created = cli(project, 'case', '--group', 'gui', '--file', 'cases/exit.json');
    expect(created.code, created.out).toBe(0);
    expect(titles()).toEqual(['Вход', 'Выход']);
  });

  it('Ф18: case --file вне проекта — относительный путь наружу отклоняется', () => {
    writeFileSync(join(root, 'outside.json'), '{"title":"Чужой"}');
    const created = cli(project, 'case', '--group', 'gui', '--file', '../outside.json');
    expect(created.code).toBe(1);
    expect(created.out).toContain('вне проекта');
    expect(titles()).toEqual(['Вход']);
  });

  it('Ф18: case --file вне проекта — абсолютный путь отклоняется', () => {
    const outside = join(root, 'outside.json');
    writeFileSync(outside, '{"title":"Чужой"}');
    const created = cli(project, 'case', '--group', 'gui', '--file', outside);
    expect(created.code).toBe(1);
    expect(created.out).toContain('вне проекта');
    expect(titles()).toEqual(['Вход']);
  });

  it('Ф18: соседний каталог с общим префиксом имени — тоже вне проекта', () => {
    mkdirSync(join(root, 'proj-evil'));
    writeFileSync(join(root, 'proj-evil', 'case.json'), '{"title":"Чужой"}');
    const created = cli(project, 'case', '--group', 'gui', '--file', '../proj-evil/case.json');
    expect(created.code).toBe(1);
    expect(created.out).toContain('вне проекта');
    expect(titles()).toEqual(['Вход']);
  });
});
