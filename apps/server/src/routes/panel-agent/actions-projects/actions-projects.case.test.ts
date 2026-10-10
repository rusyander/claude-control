import { afterEach, describe, expect, it } from 'vitest';
import type { Project } from '@agentdeck/contracts';
import { samePath } from '../actions-chat-kit.ts';
import type { InjectRoute } from '../registry.ts';
import { findProject } from './actions-projects.ts';

/**
 * Поиск проекта по пути в действиях помощника. На Windows регистр пути — не
 * разница; на Linux `/work/App` и `/work/app` — разные проекты, и свёртка
 * регистра открывала бы помощнику чужой проект.
 */
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

const onPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

afterEach(() => {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
});

const registry =
  (projects: Partial<Project>[]): InjectRoute =>
  async () => ({ status: 200, body: projects });

describe('findProject — регистр пути', () => {
  it('Linux: путь в другом регистре — не тот проект', async () => {
    onPlatform('linux');
    const inject = registry([{ id: 'p1', path: '/work/App' }]);

    await expect(findProject(inject, '/work/app')).rejects.toThrow('is not registered');
    await expect(findProject(inject, '/work/App')).resolves.toMatchObject({ id: 'p1' });
  });

  it('Windows: путь в другом регистре — тот же проект', async () => {
    onPlatform('win32');
    const inject = registry([{ id: 'p1', path: 'C:\\work\\App' }]);

    await expect(findProject(inject, 'c:\\work\\app')).resolves.toMatchObject({ id: 'p1' });
  });
});

describe('samePath — регистр пути', () => {
  it('Linux различает регистр, Windows — нет', () => {
    onPlatform('linux');
    expect(samePath('/work/App', '/work/app')).toBe(false);
    onPlatform('win32');
    expect(samePath('C:\\work\\App', 'c:\\work\\app')).toBe(true);
  });
});
