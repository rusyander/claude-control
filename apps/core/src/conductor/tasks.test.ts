import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as resumeModule from '../journal/resume.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { createTaskRegistry } from './tasks.ts';

/**
 * P11 (01 §State, F05): состояние задачи пересобирается одним путём — `resume()`; вид для чтения
 * берёт ту же свёртку у него же (`foldJournal`), и никто, кроме `resume.ts`, не импортирует
 * `reduce`. Шпионы стоят на модуле `resume.ts`: реестр и вид для чтения видят подменённые функции.
 */

vi.mock('../journal/resume.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../journal/resume.ts')>();
  return { ...real, resume: vi.fn(real.resume), foldJournal: vi.fn(real.foldJournal) };
});

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__fixtures__' ? [] : sources(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Значимые (не `import type`) импорты модуля свёртки из каждого файла ядра. */
function reduceImporters(): string[] {
  const valueImport =
    /^import\s+(?!type\b)[^;]*?from\s+'([^']*reduce\/reduce\.ts|\.\/reduce\.ts)'/gm;
  return sources(SRC)
    .filter((file) => [...readFileSync(file, 'utf8').matchAll(valueImport)].length > 0)
    .map((file) => relative(SRC, file).replaceAll('\\', '/'))
    .sort();
}

describe('task registry', () => {
  it('P11 boot opens every unfinished task through resume(); reads go through foldJournal; only resume.ts imports reduce', async () => {
    const root = tempDir('reg-');
    const first = createTaskRegistry(root, deps());
    const a = await first.create(CREATED);
    const b = await first.create(CREATED);
    const ended = await first.create(CREATED);
    ended.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'cancelled' } });
    first.closeAll();

    const resumeSpy = vi.mocked(resumeModule.resume);
    const foldSpy = vi.mocked(resumeModule.foldJournal);
    resumeSpy.mockClear();
    foldSpy.mockClear();

    // Перезапуск ядра: новая загрузка открывает незаконченные задачи.
    const second = createTaskRegistry(root, deps());
    const boot = await second.openUnfinished();
    expect(boot.opened.sort()).toEqual([a.taskId, b.taskId].sort());
    expect(boot.refused).toEqual([]);
    expect(resumeSpy.mock.calls.map((c) => c[1]).sort()).toEqual([a.taskId, b.taskId].sort());

    // Законченная задача видна через ту же свёртку, без аренды и без второго пути.
    foldSpy.mockClear();
    const view = second.view(ended.taskId);
    expect(view?.ended).toBe('cancelled');
    expect(foldSpy.mock.calls.map((c) => c[1])).toEqual([ended.taskId]);
    expect(
      second
        .list()
        .map((t) => [t.taskId, t.live])
        .sort(),
    ).toEqual(
      [
        [a.taskId, true],
        [b.taskId, true],
        [ended.taskId, false],
      ].sort(),
    );
    // Повторное открытие живой задачи не пересобирает её ещё раз.
    resumeSpy.mockClear();
    await second.open(a.taskId);
    expect(resumeSpy).not.toHaveBeenCalled();
    second.closeAll();

    expect(reduceImporters()).toEqual(['journal/resume.ts']);
  });

  it('two opens of a not-yet-open task share one resume(), never race for the lease', async () => {
    const root = tempDir('reg-');
    const first = createTaskRegistry(root, deps());
    const task = await first.create(CREATED);
    first.closeAll();
    const second = createTaskRegistry(root, deps());
    const resumeSpy = vi.mocked(resumeModule.resume);
    resumeSpy.mockClear();
    const [x, y] = await Promise.all([second.open(task.taskId), second.open(task.taskId)]);
    expect('task' in x && 'task' in y && x.task === y.task).toBe(true);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    second.closeAll();
  });

  it('P44 an unreadable tasks dir is a refusal with a reason, never «no tasks»', async () => {
    // Каталог задач есть, но прочитать его нельзя (на его месте файл → ENOTDIR).
    const notDir = join(tempDir('reg-'), 'tasks');
    writeFileSync(notDir, '');
    const registry = createTaskRegistry(notDir, deps());
    await expect(registry.openUnfinished()).rejects.toThrow(/tasks dir unreadable/);
  });
});
