import { describe, expect, it } from 'vitest';
import type { Group } from '@agentdeck/contracts';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { coreScenarioId, fromPathBody, launchInitialOf, placeInLibrary } from './coreImport';

const pathStep = (id: string, order: number) => ({
  id,
  anchor: 'work' as const,
  order,
  kind: 'prompt' as const,
  title: { ru: id, en: id },
  prompt: { ru: `p ${id}`, en: `p ${id}` },
  source: 'ru' as const,
  createdAt: '2026-10-01T00:00:00.000Z',
});

function group(extra: Partial<Group> = {}): Group {
  return {
    id: '5D1C0B7E_0a9f',
    name: 'Группа',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    isEnabled: false,
    order: 0,
    ...extra,
  } as Group;
}

const scenario = (version: number, title = 'Группа'): Scenario =>
  ({
    id: 'group-5d1c0b7e-0a9f',
    version,
    title,
    steps: [{ id: 'path-1', title: 'a' }],
  }) as unknown as Scenario;

describe('core import of an old group (stage 10, F1)', () => {
  it('scenario id is a library slug derived from the group id', () => {
    expect(coreScenarioId('5D1C0B7E_0a9f')).toBe('group-5d1c0b7e-0a9f');
    expect(coreScenarioId('___')).toBe('group-x');
    const long = coreScenarioId('a'.repeat(100));
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  });

  it('the body carries every Path step; a group without Path sends its old work order', () => {
    const steps = [pathStep('b', 1), pathStep('a', 0)];
    const body = fromPathBody(group({ flow: 'scenario', path: { steps } } as Partial<Group>), 'ru');
    expect(body).toMatchObject({ id: 'group-5d1c0b7e-0a9f', title: 'Группа', flow: 'scenario' });
    expect(body.path?.steps.map((s) => s.id)).toEqual(['b', 'a']);
    expect(body.legacy).toBeUndefined();

    const old = fromPathBody(
      group({ scenario: { when: '', trigger: '', steps: [{ title: 't', body: 'b', gate: '' }] } }),
      'ru',
    );
    expect(old.path).toBeUndefined();
    expect(old.legacy?.steps).toEqual([{ title: 't', body: 'b', gate: '' }]);
  });

  it('the body carries the interface language, so the core names every step in it', () => {
    expect(fromPathBody(group(), 'en').lang).toBe('en');
    expect(fromPathBody(group(), 'en-US').lang).toBe('en');
    expect(fromPathBody(group(), 'ru').lang).toBe('ru');
    // Язык, которого у ядра нет, — русский, как у пресетов, а не отказ 400.
    expect(fromPathBody(group(), 'de').lang).toBe('ru');
  });

  it('the same scenario is reused without a save; a changed one gets latest + 1', () => {
    expect(placeInLibrary(scenario(1), [])).toEqual({
      ref: { id: 'group-5d1c0b7e-0a9f', version: 1 },
      save: scenario(1),
    });
    expect(placeInLibrary(scenario(1), [scenario(3)])).toEqual({
      ref: { id: 'group-5d1c0b7e-0a9f', version: 3 },
      save: null,
    });
    const changed = placeInLibrary(scenario(1, 'Другая'), [scenario(1), scenario(2)]);
    expect(changed.ref.version).toBe(3);
    expect(changed.save?.version).toBe(3);
  });

  it('launch draft takes only the name, the scenario and a project group own project', () => {
    const ref = { id: 'group-x', version: 2 };
    expect(launchInitialOf(group(), ref)).toEqual({
      title: 'Группа',
      scenario: { kind: 'library', id: 'group-x', version: 2 },
    });
    const project = launchInitialOf(
      group({ scope: { kind: 'project', path: '/work/app' } } as Partial<Group>),
      ref,
    );
    expect(project.repos).toEqual([{ path: '/work/app', baseRef: '' }]);
  });
});
