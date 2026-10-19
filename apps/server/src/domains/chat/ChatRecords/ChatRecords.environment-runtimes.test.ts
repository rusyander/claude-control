import { describe, expect, it } from 'vitest';
import { environmentPreamble } from '@agentdeck/contracts/task-split';

/**
 * Задание агенту в копии (T1/T8, T15): провал подготовки называет первую
 * строку настоящей ошибки и путь к полному логу, а версия рантайма проекта —
 * что панель с ней сделала. Живой случай 13.10.2026: два килобайта
 * `npm warn EBADENGINE` в хвосте прятали причину, а Node 24 при `.nvmrc` 22
 * агенту никто не назвал.
 */

const FAILED = {
  status: 'failed',
  command: 'npm ci',
  exitCode: 2,
  logTail: 'npm error code ELIFECYCLE',
  firstError: 'npm error code ELIFECYCLE',
  logFile: '/data/worktree-logs/copy.log',
} as never;

describe('преамбула окружения: провал подготовки', () => {
  it('первая строка ошибки и путь к полному логу вместо хвоста', () => {
    const text = environmentPreamble({ bootstrap: FAILED });
    expect(text).toContain('First error: npm error code ELIFECYCLE');
    expect(text).toContain('Full log: /data/worktree-logs/copy.log');
    expect(text).not.toContain('Log tail');
  });

  it('записи без firstError (прежний формат) — хвост, как раньше', () => {
    const text = environmentPreamble({
      bootstrap: { status: 'failed', command: 'npm ci', exitCode: 1, logTail: 'ERR x' } as never,
    });
    expect(text).toContain('Log tail:\nERR x');
    expect(text).not.toContain('Full log');
  });
});

describe('преамбула окружения: версии рантайма', () => {
  const ok = { status: 'ok', command: 'npm ci', logTail: '' };

  it('переключились: на какой версии собрана копия и что брать агенту', () => {
    const text = environmentPreamble({
      bootstrap: {
        ...ok,
        runtimes: [
          {
            tool: 'node',
            where: '',
            wanted: '22',
            source: '.nvmrc',
            status: 'switched',
            used: '22.22.2',
            found: '24.13.0',
          },
        ],
      } as never,
    });
    expect(text).toContain('Node: the project asks for 22 (.nvmrc)');
    expect(text).toContain('prepared the copy on 22.22.2');
    expect(text).toContain('machine default is 24.13.0');
  });

  it('нужной версии нет: предупреждение, без «молчаливого» обхода', () => {
    const text = environmentPreamble({
      bootstrap: {
        ...ok,
        runtimes: [
          {
            tool: 'python',
            where: 'svc',
            wanted: '3.12',
            source: '.python-version',
            status: 'missing',
            found: '3.14.0',
          },
        ],
      } as never,
    });
    expect(text).toContain('⚠ Python in svc/: the project asks for 3.12 (.python-version)');
    expect(text).toContain('no venv was built');
    expect(text).toContain('never work around it silently');
  });

  it('Go готов: команда запуска тестов — в задании', () => {
    const text = environmentPreamble({
      bootstrap: {
        ...ok,
        runtimes: [
          {
            tool: 'go',
            where: 'api',
            wanted: '>=1.25.0',
            source: 'go.mod',
            status: 'ok',
            used: '1.25.3',
            run: 'go test ./...',
          },
        ],
      } as never,
    });
    expect(text).toContain('Go in api/: the project asks for >=1.25.0 (go.mod): ready on 1.25.3');
    expect(text).toContain('Run it with: go test ./...');
  });

  it('рантаймов нет — преамбула прежняя, без лишних строк', () => {
    expect(environmentPreamble({ bootstrap: ok as never })).not.toContain('the project asks for');
  });
});

/**
 * Монорепозиторий (замер 16.10.2026): ~40 модулей, по строке на каждый — 9–10
 * тыс. знаков в задании каждой группы и в каждом её вызове. Одинаковые строки
 * склеиваются, модули вне зоны группы — одной строкой; версия и команда
 * запуска при этом остаются в тексте.
 */
describe('преамбула окружения: монорепозиторий и зона группы', () => {
  const ok = { status: 'ok', command: 'npm ci', logTail: '' };
  const go = (where: string) => ({
    tool: 'go',
    where,
    wanted: '>=1.25.0',
    source: `${where}/go.mod go`,
    status: 'ok',
    used: '1.27.0',
    run: 'go test ./...',
  });
  const node = (where: string) => ({
    tool: 'node',
    where,
    wanted: '>=22.22.2 <23',
    source: `${where}/package.json engines`,
    status: 'switched',
    used: '22.23.2',
    found: '24.13.0',
    detail: 'nvm-windows: C:\\Program Files\\nvm\\v22.23.2',
  });
  const pyFailed = (where: string) => ({
    tool: 'python',
    where,
    wanted: '>=3.12',
    source: `${where}/pyproject.toml requires-python`,
    status: 'failed',
    detail: '«.venv/python -m pip install -r requirements.txt» завершилась с кодом 1',
  });
  const GO = Array.from({ length: 25 }, (_, i) => `svc-${String(i).padStart(2, '0')}`);
  const PY = ['mod-a', 'mod-b', 'mod-c', 'mod-d', 'mod-e', 'mod-f'];
  const runtimes = [
    node('shared-ui'),
    node('admin-ui'),
    ...GO.map(go),
    node('chat-ui'),
    ...PY.map(pyFailed),
  ];
  const before = (bootstrap: unknown) => environmentPreamble({ bootstrap: bootstrap as never });

  it('одинаковые строки склеиваются: каждая среда один раз, все модули названы', () => {
    const text = before({ ...ok, runtimes });
    expect(text.match(/the project asks for >=1\.25\.0/g)).toHaveLength(1);
    expect(text).toContain(`Go in ${GO.map((m) => `${m}/`).join(', ')} (25 modules)`);
    expect(text).toContain('(go.mod go): ready on 1.27.0. Run it with: go test ./...');
    expect(text.match(/Use 22\.23\.2 for installs and runs/g)).toHaveLength(1);
    // R7: чат панели уже на этой версии — проверить раз, не приписывать PATH к каждому Bash.
    expect(text).toContain('already has it first in PATH: check `node -v` once');
    expect(text.match(/check `node -v` once/g)).toHaveLength(1);
    expect(text).toContain('Node in shared-ui/, admin-ui/, chat-ui/ (3 modules)');
    expect(text.match(/preparing it failed/g)).toHaveLength(1);
    expect(text).toContain(
      '⚠ Python in mod-a/, mod-b/, mod-c/, mod-d/, mod-e/, mod-f/ (6 modules)',
    );
  });

  it('зона группы: свои модули полностью, чужие — одной строкой с версией и командой', () => {
    const text = environmentPreamble({
      bootstrap: { ...ok, runtimes } as never,
      scope: ['admin-ui/src/features/builder (кроме строки копирования)', 'shared-ui'],
    });
    expect(text).toContain(
      'Node in shared-ui/, admin-ui/ (2 modules): the project asks for >=22.22.2 <23 (package.json engines)',
    );
    const outside = text.split('\n').filter((line) => line.startsWith("Outside this group's zone"));
    expect(outside).toHaveLength(1);
    expect(outside[0]).toContain('Go ready on 1.27.0 in svc-00/');
    expect(outside[0]).toContain('— run: go test ./...');
    expect(outside[0]).toContain('Node ready on 22.23.2 in chat-ui/');
    expect(outside[0]).toContain('⚠ Python preparation failed in mod-a/');
    // Чужие модули не зовут агента «решать самому, повторять ли»: он их не трогает.
    expect(text).not.toContain('Decide yourself: retry');
  });

  /** Ревью B1-F6: такая зона выносила за неё все модули вместе с «первым в PATH». */
  it('зона, записанная моделью корнем, шаблоном, с косой или другим регистром', () => {
    const zoned = (scope: string[]) =>
      environmentPreamble({ bootstrap: { ...ok, runtimes } as never, scope });
    for (const whole of [['.'], ['./'], ['*'], ['**/*.go'], ['C:/work/repo/api']]) {
      const text = zoned(whole);
      expect(text, whole[0]).not.toContain("Outside this group's zone");
      expect(text, whole[0]).toContain('Use 22.23.2 for installs and runs (put it first in PATH)');
    }
    for (const own of [['/shared-ui'], ['Shared-UI/src'], ['shared-ui/**/*.tsx']]) {
      const text = zoned(own);
      expect(text, own[0]).toContain('Node in shared-ui/: the project asks for');
      expect(text, own[0]).toContain("Outside this group's zone");
    }
  });

  it('потолок: двадцать восемь модулей вне зоны стоят меньше 1,5 тыс. знаков, а не 9', () => {
    const flat = before({ ...ok, runtimes });
    const scoped = environmentPreamble({
      bootstrap: { ...ok, runtimes } as never,
      scope: ['admin-ui/src'],
    });
    expect(flat.length).toBeLessThan(2_200);
    expect(scoped.length).toBeLessThan(1_500);
  });

  it('один модуль — прежняя строка с полным источником', () => {
    expect(before({ ...ok, runtimes: [go('api')] })).toContain(
      'Go in api/: the project asks for >=1.25.0 (api/go.mod go): ready on 1.27.0',
    );
  });
});
