import { describe, expect, it } from 'vitest';
import type { GroupMember } from '@agentdeck/contracts';
import { assistantSchema, readAssistantFields } from '@shared/lib/assistant-fields';
import { groupAssistantSpec, memberRef, membersFromRefs } from './groupAssistant';
import { memberCatalog } from './memberCatalog';

/**
 * Помощник «Нового набора» (владелец 28.09): состав и проекты — такие же поля,
 * как имя. Каталог — тот же, что у выбора участников; чего в нём нет, форма
 * не отмечает и называет.
 */
const catalog = memberCatalog(
  {
    rules: [{ id: 'r1', title: 'No push' }],
    skills: [{ id: 'audit', name: 'audit' }],
    hooks: [
      { id: 'h1', event: 'PreToolUse', matcher: 'Bash', source: 'settings' },
      { id: 'local:Stop:x', event: 'Stop', source: 'settings-local' },
    ],
    servers: [{ id: 'gitlab', name: 'gitlab' }],
    permissions: [{ id: 'p1', decision: 'deny', pattern: 'Bash(rm:*)' }],
    groups: [
      { id: 'g-self', name: 'Self' },
      { id: 'g2', name: 'Nested' },
    ],
  },
  'g-self',
);

const current: GroupMember[] = [
  { kind: 'rule', id: 'r1' },
  // Проектный участник: в общих списках его нет, но он в составе.
  { kind: 'skill', id: 'proj-skill', scope: { kind: 'project', path: '/p', provider: 'claude' } },
];

const spec = groupAssistantSpec({
  catalog,
  members: current,
  projects: [{ path: '/work/app', name: 'app' }],
  projectPaths: ['/gone'],
});

describe('каталог участников', () => {
  it('локальный хук и сама группа в выбор не попадают', () => {
    const refs = catalog.map(memberRef);
    expect(refs).toEqual([
      'rule:r1',
      'skill:audit',
      'hook:h1',
      'mcp:gitlab',
      'permission:p1',
      'group:g2',
    ]);
  });
});

describe('помощник формы группы', () => {
  const schema = assistantSchema(spec);

  it('задание несёт состав и проекты с допустимыми значениями', () => {
    expect(Object.keys(schema)).toEqual([
      'name',
      'description',
      'when',
      'envText',
      'members',
      'projectPaths',
    ]);
    expect(schema.members).toContain('"permission:p1" (permission · deny · Bash(rm:*))');
    expect(schema.members).toContain('"skill:proj-skill"');
    expect(schema.projectPaths).toContain('"/work/app" (app)');
    expect(schema.projectPaths).toContain('"/gone"');
  });

  it('известные участники и проект применяются, выдуманные названы', () => {
    const reading = readAssistantFields(spec, {
      members: ['group:g2', 'rule:r1', 'rule:nope'],
      projectPaths: ['/work/app', '/nowhere'],
    });
    expect(reading.values.members).toEqual(['group:g2', 'rule:r1']);
    expect(reading.values.projectPaths).toEqual(['/work/app']);
    expect(reading.missed).toEqual([
      { field: 'members', reason: 'unknown-value', values: ['rule:nope'] },
      { field: 'projectPaths', reason: 'unknown-value', values: ['/nowhere'] },
    ]);
  });

  it('сама группа участником не принимается', () => {
    const reading = readAssistantFields(spec, { members: ['group:g-self'] });
    expect(reading.applied).toEqual([]);
  });

  it('значение не того вида не применяется', () => {
    const reading = readAssistantFields(spec, { members: 'rule:r1', when: { a: 1 } });
    expect(reading.values).toEqual({});
    expect(reading.missed.map((miss) => miss.reason)).toEqual(['wrong-type', 'wrong-type']);
  });
});

describe('membersFromRefs — ссылки в состав', () => {
  it('стоящий участник сохраняет свою область, новый берётся из общих списков', () => {
    const next = membersFromRefs(['skill:proj-skill', 'hook:local:Stop:x'], current, {
      kind: 'project',
      path: '/p',
      provider: 'claude',
    });
    expect(next[0]).toBe(current[1]);
    // В проектной группе выбранное из общих списков помечено глобальным.
    expect(next[1]).toEqual({ kind: 'hook', id: 'local:Stop:x', scope: { kind: 'global' } });
  });

  it('в глобальной группе новый участник — без области', () => {
    expect(membersFromRefs(['mcp:gitlab'], [], undefined)).toEqual([{ kind: 'mcp', id: 'gitlab' }]);
  });
});
