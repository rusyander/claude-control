import { describe, expect, it } from 'vitest';
import { pickedMember } from './memberScope';
import { memberLivesIn } from './memberLivesIn';

const PROJECT = { kind: 'project', path: 'C:/work/shop', provider: 'claude' } as const;

describe('область участника группы', () => {
  it('общий ресурс в проектной группе несёт scope: global', () => {
    const member = pickedMember(PROJECT, 'skill', 'ladder', 'global');
    expect(member).toEqual({ kind: 'skill', id: 'ladder', scope: { kind: 'global' } });
    expect(memberLivesIn(PROJECT, member)).toBe('global');
  });

  it('проектный ресурс проектной группы и ресурс глобальной группы — без поля', () => {
    expect(pickedMember(PROJECT, 'skill', 'ladder', 'project')).toEqual({
      kind: 'skill',
      id: 'ladder',
    });
    expect(pickedMember({ kind: 'global' }, 'rule', 'r', 'global')).toEqual({
      kind: 'rule',
      id: 'r',
    });
    expect(memberLivesIn(PROJECT, { kind: 'skill', id: 'ladder' })).toBe('project');
    expect(memberLivesIn(undefined, { kind: 'skill', id: 'ladder' })).toBe('global');
  });
});
