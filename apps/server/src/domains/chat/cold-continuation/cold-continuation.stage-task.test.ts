import { describe, expect, it } from 'vitest';
import { GROUP_TASKS_HEADER, coldResumeBrief } from '../split-continue.ts';
import { STAGE_TASK_LINE, withStageTask } from './cold-continuation.ts';

/**
 * Вводная нового разговора = шапка (ветка, задачи группы) + задание стадии.
 * Задание группы уже перечисляет задачи дословно: g0 25.10 нёс список дважды
 * (1,8k знаков на холодную вводную). Повтор уходит, незнакомая заданию задача
 * остаётся.
 */

const TASKS = [
  'PROJ-1 — Выгрузка CSV (https://tracker.example.com/browse/PROJ-1)',
  'PROJ-2 — Фильтр по дате',
];

describe('withStageTask и список задач группы', () => {
  it('задачи, которые задание стадии называет дословно, шапка не повторяет', () => {
    const task = `Задачи:\n1. ${TASKS[0]}\n2. ${TASKS[1]}\nСделай.`;
    const out = withStageTask(coldResumeBrief({ branch: 'feat/csv', mr: '!7' }, TASKS), task);
    expect(out.split(TASKS[0]!)).toHaveLength(2);
    expect(out.split(TASKS[1]!)).toHaveLength(2);
    expect(out).not.toContain(GROUP_TASKS_HEADER);
    expect(out).toContain('Branch feat/csv, MR !7.');
    expect(out).toContain(`${STAGE_TASK_LINE}\n\n${task}`);
  });

  it('задача, которой нет в задании стадии, остаётся в шапке', () => {
    const task = `Ревью ветки: ${TASKS[0]}`;
    const out = withStageTask(coldResumeBrief({ branch: 'feat/csv' }, TASKS), task);
    expect(out).toContain(`${GROUP_TASKS_HEADER}\n- ${TASKS[1]}\n`);
    expect(out).not.toContain(`- ${TASKS[0]}`);
  });

  it('шапка без списка задач проходит как есть', () => {
    const intro = coldResumeBrief({ branch: 'feat/csv' }, []);
    expect(withStageTask(intro, 'Сделай.')).toBe(`${intro}\n${STAGE_TASK_LINE}\n\nСделай.`);
  });
});
