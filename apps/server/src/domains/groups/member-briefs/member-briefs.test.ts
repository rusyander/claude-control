import { describe, it, expect } from 'vitest';
import type { Group } from '@agentdeck/contracts';
import { memberBriefs } from './member-briefs.ts';

/**
 * Ревью 28.09 (F-253): описание вложенной группы было зашитой английской
 * фразой `group «имя»` — русский интерфейс показывал её в строке участника.
 * Вид участника и так приходит полем `kind`; описание — только имя.
 */

const group = (id: string, name: string, members: Group['members'] = []): Group =>
  ({ id, name, description: '', members, env: {}, isEnabled: true, order: 0 }) as Group;

describe('memberBriefs: вложенная группа', () => {
  it('описание — имя группы, без английской обёртки', () => {
    const nested = group('n', 'Ревью');
    const outer = group('o', 'Выпуск', [{ kind: 'group', id: 'n' }]);
    const deps = { store: { getGroups: () => [nested, outer] } } as never;
    expect(memberBriefs(deps, outer)).toEqual([{ kind: 'group', id: 'n', description: 'Ревью' }]);
  });
});
