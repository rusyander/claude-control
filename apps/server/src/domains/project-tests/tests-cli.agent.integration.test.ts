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

  it('case в несуществующую группу — отказ с похожими, группа не заводится; --new-group заводит', () => {
    const refused = cli(project, 'case', '--group', 'guide', '--json', '{"title":"Выход"}');
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('Группы «guide» в проекте нет (похожие: gui)');
    expect(readGroups(project).map((group) => group.id)).toEqual(['gui']);
    const created = cli(
      project,
      'case',
      '--group',
      'guide',
      '--new-group',
      '--json',
      '{"title":"Выход"}',
    );
    expect(created.code).toBe(0);
    expect(
      readGroups(project)
        .map((group) => group.id)
        .sort(),
    ).toEqual(['gui', 'guide']);
  });

  it('case в проекте без групп — первая группа заводится без --new-group', () => {
    const fresh = join(root, 'fresh');
    mkdirSync(fresh);
    const out = cli(fresh, 'case', '--group', 'auth', '--json', '{"title":"Вход"}');
    expect(out.code).toBe(0);
    expect(readGroups(fresh).map((group) => group.id)).toEqual(['auth']);
  });

  it('case по id с одними метками — правка меток, название остаётся; show печатает метки', () => {
    // g1 26.10: `{"id":…,"tags":[…]}` отбит «нужно название», метки ушли скриптом в 5 ходов.
    cli(project, 'case', '--group', 'gui', '--json', '{"title":"Выход","steps":["выйти"]}');
    const tagged = cli(
      project,
      'case',
      '--group',
      'gui',
      '--json',
      '{"id":"gui-002","tags":["live","e2e"]}',
    );
    expect(tagged.code, tagged.out).toBe(0);
    expect(tagged.out).toContain('Обновлён кейс gui:gui-002 — Выход');
    const shown = cli(project, 'show', 'gui:gui-002');
    expect(shown.out).toContain('1. выйти');
    expect(shown.out).toContain('Метки: live, e2e');
  });

  it('case по id с archived — кейс агента уходит в архив и возвращается; у кейса человека — черновик и слово об этом', () => {
    // W1-D 08.11: `case` тихо выбрасывал `archived` — кейсы на убранные файлы архивировали руками в JSON.
    cli(project, 'case', '--group', 'gui', '--json', '{"title":"Выход","steps":["выйти"]}');
    const archived = cli(
      project,
      'case',
      '--group',
      'gui',
      '--json',
      '{"id":"gui-002","archived":true}',
    );
    expect(archived.code, archived.out).toBe(0);
    const caseOf = (id: string) => readGroups(project)[0]?.cases.find((item) => item.id === id);
    expect(caseOf('gui-002')).toMatchObject({ title: 'Выход', archived: true });
    expect(cli(project, 'list', '--group', 'gui').out).toContain('(архив)');
    const back = cli(
      project,
      'case',
      '--group',
      'gui',
      '--json',
      '{"id":"gui-002","archived":false}',
    );
    expect(back.code, back.out).toBe(0);
    expect(caseOf('gui-002')?.archived).toBeFalsy();
    // Кейс человека агент не архивирует: правка — черновиком, и вывод это говорит, а не молчит.
    const human = cli(
      project,
      'case',
      '--group',
      'gui',
      '--json',
      '{"id":"gui-001","archived":true}',
    );
    expect(human.code, human.out).toBe(0);
    expect(human.out).toContain('черновиком');
    expect(human.out).toContain('Архив кейса человека');
    expect(caseOf('gui-001')?.archived).toBeFalsy();
  });

  it('--project из подкаталога — ближайший вверх с .agent/tests, но не выше корня git', () => {
    // g0 26.10: после `cd inst-api` `--project .` искал файлы в `inst-api/.agent/tmp`.
    const sub = join(project, 'pkg', 'src');
    mkdirSync(sub, { recursive: true });
    expect(cli(sub, 'show', 'gui:gui-001').out).toContain('Группа: gui');
    // Вложенный репозиторий (копия в .claude/worktrees) кейсы внешнего не берёт.
    const nested = join(project, 'nested');
    mkdirSync(join(nested, '.git'), { recursive: true });
    expect(cli(nested, 'show', 'gui:gui-001').out).toContain('в проекте нет');
  });

  it('case с придуманным id — новый кейс, вывод называет оба id (3.4)', () => {
    const created = cli(
      project,
      'case',
      '--group',
      'gui',
      '--json',
      '{"id":"gui-exit","title":"Выход"}',
    );
    expect(created.code, created.out).toBe(0);
    expect(created.out).toContain('Кейса «gui-exit» в группе не было — заведён новый gui:gui-002');
    expect(titles()).toEqual(['Вход', 'Выход']);
  });

  // L6.2: подсказка называет кейсы, а не группу — группа может нести живые QA.
  it('record автокейсов — отказ с командой run --case ровно этих кейсов', () => {
    for (const title of ['Юнит', 'Ещё юнит']) {
      const json = JSON.stringify({
        title,
        automation: { status: 'automated', file: 'src/a.test.ts' },
      });
      expect(cli(project, 'case', '--group', 'gui', '--json', json).code).toBe(0);
    }
    const recorded = cli(project, 'record', 'gui:gui-002=passed', 'gui:gui-003=passed');
    expect(recorded.code).not.toBe(0);
    expect(recorded.out).toContain(`run --project "${project}" --case gui:gui-002,gui:gui-003`);
    expect(recorded.out).not.toContain('--group');
    expect(readRuns(project)).toEqual([]);
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
