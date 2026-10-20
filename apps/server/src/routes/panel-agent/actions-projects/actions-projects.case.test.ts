import { describe, expect, it } from 'vitest';
import type { Project } from '@agentdeck/contracts';
import { samePath } from '../actions-chat-kit.ts';
import type { InjectRoute } from '../registry.ts';
import { findProject } from './actions-projects.ts';

/**
 * Поиск проекта по пути в действиях помощника. На Windows регистр пути — не
 * разница; на Linux `/work/App` и `/work/app` — разные проекты, и свёртка
 * регистра открывала бы помощнику чужой проект. Путь проходит `resolve` хоста,
 * поэтому каждый случай идёт на своей системе: подмена `process.platform` не
 * меняет модуль `path`, и `/work/App` на Windows всё равно стал бы `C:\work\App`.
 */
const posix = process.platform !== 'win32';

const registry =
  (projects: Partial<Project>[]): InjectRoute =>
  async () => ({ status: 200, body: projects });

describe('findProject — регистр пути', () => {
  it.runIf(posix)('Linux: путь в другом регистре — не тот проект', async () => {
    const inject = registry([{ id: 'p1', path: '/work/App' }]);

    await expect(findProject(inject, '/work/app')).rejects.toThrow('is not registered');
    await expect(findProject(inject, '/work/App')).resolves.toMatchObject({ id: 'p1' });
  });

  it.runIf(!posix)('Windows: путь в другом регистре — тот же проект', async () => {
    const inject = registry([{ id: 'p1', path: 'C:\\work\\App' }]);

    await expect(findProject(inject, 'c:\\work\\app')).resolves.toMatchObject({ id: 'p1' });
  });
});

describe('samePath — регистр пути', () => {
  it('Linux различает регистр, Windows — нет', () => {
    if (posix) expect(samePath('/work/App', '/work/app')).toBe(false);
    else expect(samePath('C:\\work\\App', 'c:\\work\\app')).toBe(true);
  });
});
