import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupRunProfile, KIT_HOOKS_DIR, KIT_HOOKS_DIR_ENV } from './group-profile.ts';

/**
 * Каталог хуков набора в окружении звена: глобальный `gate-at-end` отдаёт ему решение
 * о полном гейте группы (группа №1 24.10 — 21 полный гейт, правила звеньев не исполнялись).
 */
describe('каталог хуков набора — в окружении звена группы', () => {
  it('звено и очередь тяжёлых прогонов несут путь к настоящему gate-at-end набора', () => {
    expect(existsSync(join(KIT_HOOKS_DIR, 'lib', 'gate-at-end.mjs'))).toBe(true);
    const input = { entries: [], tasksText: '', extra: [] };
    expect(groupRunProfile({ ...input, stage: 'work' }).env[KIT_HOOKS_DIR_ENV]).toBe(KIT_HOOKS_DIR);
    const queued = groupRunProfile({ ...input, heavyQueue: { hook: 'node q.mjs', dir: 'C:/q' } });
    expect(queued.env[KIT_HOOKS_DIR_ENV]).toBe(KIT_HOOKS_DIR);
    // Без звена (лёгкий чат, прогон вне группы) — нет и переменной.
    expect(groupRunProfile(input).env).not.toHaveProperty(KIT_HOOKS_DIR_ENV);
  });
});
