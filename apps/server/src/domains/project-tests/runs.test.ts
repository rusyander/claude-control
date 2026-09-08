import type { ProjectTestEnvironment } from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { pickEnvironmentId } from './runs.ts';

/**
 * Реестр прогонов спавнит настоящий CLI, поэтому юнитами проверяется то, что
 * решается ДО запуска, — здесь выбор окружения.
 *
 * Случай «ничего не выбрали» и есть тот, из-за которого прогон уходил без
 * адреса стенда и без его доступов: пульт с выбором «по умолчанию» не шлёт
 * `environmentId` вовсе.
 */
describe('project-tests/runs: окружение прогона', () => {
  const environments: ProjectTestEnvironment[] = [
    { id: 'local', title: 'Локальное' },
    { id: 'stand', title: 'Стенд', isDefault: true },
    { id: 'old', title: 'Старый', archived: true, isDefault: true },
  ];

  it('названное человеком побеждает всё остальное', () => {
    expect(pickEnvironmentId(environments, 'local', 'stand')).toBe('local');
  });

  it('не названо — берётся окружение плана', () => {
    expect(pickEnvironmentId(environments, undefined, 'local')).toBe('local');
  });

  it('не названо и плана нет — подставляется окружение по умолчанию', () => {
    expect(pickEnvironmentId(environments, undefined, undefined)).toBe('stand');
  });

  it('окружений нет вовсе — прогон идёт без окружения, а не падает', () => {
    expect(pickEnvironmentId([], undefined, undefined)).toBeUndefined();
  });

  it('архивное окружение по умолчанию не всплывает', () => {
    expect(pickEnvironmentId([environments[2]!], undefined, undefined)).toBeUndefined();
  });
});
