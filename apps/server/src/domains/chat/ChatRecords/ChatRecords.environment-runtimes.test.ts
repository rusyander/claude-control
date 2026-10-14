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
