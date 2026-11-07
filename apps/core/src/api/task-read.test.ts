import { describe, expect, it } from 'vitest';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { taskListOf, taskListQuery } from './task-read.ts';

/**
 * Фильтр списка задач (этап 11, W3-18) над настоящим реестром: `groupId` — пункты группы (без
 * дочерних задач XL, даже если у них та же группа), `parentTaskId` — дети одного XL. Строка
 * запроса берёт только непустые строки: пустой или нестроковый фильтр — как его нет.
 */

async function seeded() {
  const registry = createTaskRegistry(tempDir('task-read-'), deps());
  const plain = await registry.create(CREATED);
  const item1 = await registry.create({ ...CREATED, groupId: 'g1' });
  const item2 = await registry.create({ ...CREATED, groupId: 'g1' });
  const other = await registry.create({ ...CREATED, groupId: 'g2' });
  const child = await registry.create({ ...CREATED, groupId: 'g1', parentTaskId: item1.taskId });
  const loose = await registry.create({ ...CREATED, parentTaskId: item1.taskId });
  return { registry, plain, item1, item2, other, child, loose };
}

const ids = (items: { taskId: string }[]) => items.map((t) => t.taskId).sort();

describe('task list filter (stage 11, W3-18)', () => {
  it('groupId keeps the items of that group only — not another group, not an XL child of it', async () => {
    const s = await seeded();
    expect(ids(taskListOf(s.registry, { groupId: 'g1' }))).toEqual(
      [s.item1.taskId, s.item2.taskId].sort(),
    );
    expect(ids(taskListOf(s.registry, { groupId: 'g2' }))).toEqual([s.other.taskId]);
    expect(taskListOf(s.registry, { groupId: 'none' })).toEqual([]);
  });

  it('parentTaskId keeps the children of that XL; both filters must hold together', async () => {
    const s = await seeded();
    expect(ids(taskListOf(s.registry, { parentTaskId: s.item1.taskId }))).toEqual(
      [s.child.taskId, s.loose.taskId].sort(),
    );
    // Ребёнок с группой — не пункт группы: вместе фильтры не дают никого.
    expect(taskListOf(s.registry, { groupId: 'g1', parentTaskId: s.item1.taskId })).toEqual([]);
  });

  it('no filter lists every task, and each row carries its link fields', async () => {
    const s = await seeded();
    const all = taskListOf(s.registry, {});
    expect(all).toHaveLength(6);
    const row = all.find((t) => t.taskId === s.child.taskId);
    expect(row).toMatchObject({ groupId: 'g1', parentTaskId: s.item1.taskId });
  });

  it('query parsing: only non-empty strings become filters', () => {
    expect(taskListQuery({ groupId: 'g1', parentTaskId: 'p1' })).toEqual({
      groupId: 'g1',
      parentTaskId: 'p1',
    });
    expect(taskListQuery({ groupId: '', parentTaskId: ['p1'] })).toEqual({});
    expect(taskListQuery(undefined)).toEqual({});
    expect(taskListQuery({ other: 'x' })).toEqual({});
  });
});
