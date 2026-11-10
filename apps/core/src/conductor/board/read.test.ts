import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CREATED, deps, fakeClock, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { createTaskRegistry, type TaskRegistry } from '../tasks.ts';
import { createTaskReader, foldTask } from './read.ts';

/**
 * Чтение задач доской (этап 12, P159): настоящий реестр и настоящие журналы на диске; подменена
 * только свёртка — обёрткой, которая считает вызовы настоящей `foldTask`.
 */

const opened: TaskRegistry[] = [];
afterEach(() => {
  for (const r of opened.splice(0)) r.closeAll();
});

async function home(n: number): Promise<{ registry: TaskRegistry; ids: string[] }> {
  const registry = createTaskRegistry(tempDir('board-read-'), deps({ clock: fakeClock() }));
  opened.push(registry);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) ids.push((await registry.create(CREATED)).taskId);
  registry.closeAll();
  return { registry, ids };
}

describe('board task reader (P159)', () => {
  it('folds each finished journal once, again only when the journal grew; a live task is never folded', async () => {
    const { registry, ids } = await home(3);
    const folded: string[] = [];
    const reader = createTaskReader({
      registry,
      fold: (dir, id) => {
        folded.push(id);
        return foldTask(dir, id);
      },
    });
    const first = reader.states().states;
    expect(first).toHaveLength(3);
    // Свёрнут настоящий журнал задачи, не пустой: постановка на месте, строки прочитаны.
    for (const s of first) expect([s.created?.title, s.seq > 0]).toEqual([CREATED.title, true]);
    expect(folded.sort()).toEqual([...ids].sort());
    folded.length = 0;
    expect(reader.states().states).toHaveLength(3);
    expect(folded).toEqual([]);

    // Задача снова живая в этом ядре: её состояние в памяти, свёртки нет.
    const got = await registry.open(ids[0]!);
    if (!('task' in got)) throw new Error(got.refused);
    got.task.append({
      kind: 'task.transition',
      actor: 'core',
      data: { taskId: ids[0]!, event: 'estimate', from: 'draft', to: 'estimating' },
    });
    const live = reader.states().states.find((s) => s.taskId === ids[0]);
    expect(live?.task).toBe('estimating');
    expect(folded).toEqual([]);

    // Закрыта, журнал вырос — свёрнута заново ровно она, с новым состоянием.
    registry.closeAll();
    const after = reader.states().states.find((s) => s.taskId === ids[0]);
    expect(folded).toEqual([ids[0]]);
    expect(after?.task).toBe('estimating');
  });

  it('a journal that cannot be read is named in problems, the other tasks still come back', async () => {
    const { registry, ids } = await home(2);
    const reader = createTaskReader({
      registry,
      fold: (dir, id) => {
        if (id === ids[1]) throw new Error('torn journal');
        return foldTask(dir, id);
      },
    });
    const got = reader.states();
    expect(got.states.map((s) => s.taskId)).toEqual([ids[0]]);
    expect(got.problems).toEqual([`${ids[1]}: torn journal`]);
  });
});

/** Транзитивные значимые импорты модуля внутри `apps/core/src` (`import type` стирается при запуске). */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^\s*(import|export)\s+(?!type\b)[^'"]*?from\s+'(\.[^']+)'/gm)) {
      walk(resolve(dirname(file), m[2]!));
    }
  };
  walk(entry);
  return seen;
}

describe('board read path imports only the journal (P159)', () => {
  it('no adapter, forge or transcript module is reachable from the board view', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const graph = [
      ...importGraph(join(here, 'board.ts')),
      ...importGraph(join(here, '../../api/board-view.ts')),
    ].map((f) => f.replace(/\\/g, '/'));
    expect(graph.some((f) => f.endsWith('/journal/read-view.ts'))).toBe(true);
    const banned = graph.filter((f) => /\/(adapters|forge|transcript|session-host)\b/.test(f));
    expect(banned).toEqual([]);
  });
});
