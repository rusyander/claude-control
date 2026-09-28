import { describe, expect, it } from 'vitest';
import {
  migrateScenarioSteps,
  PATH_ANCHORS,
  pathStepSchema,
} from '@agentdeck/contracts/group-path';
import { groupKeyOf, parseGroupKey, scopeOf } from '@agentdeck/contracts/group-sources';
import {
  AUTONOMOUS_PICK_MARKER,
  autonomousPickMessage,
  pickRecommended,
  resolveChatGroupSettings,
} from '@agentdeck/contracts/chat-group-settings';
import { groupSchema } from '@agentdeck/contracts/groups';

describe('group path contracts', () => {
  it('push is never an anchor — it is a manual click, nothing follows it', () => {
    expect(PATH_ANCHORS).toEqual(['triage', 'plan', 'work', 'review', 'fix', 'deliver']);
  });

  it('old scenario steps become prompt steps after work, flagged for translation', () => {
    const steps = migrateScenarioSteps(
      {
        steps: [
          { title: 'Прочитай тикет', body: 'Открой задачу', gate: 'Критерии выписаны' },
          { title: '', body: '  ', gate: '' },
          { title: 'Тесты', body: '', gate: '' },
        ],
      },
      '2026-09-26T00:00:00.000Z',
      (index) => `s${index}`,
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      id: 's0',
      anchor: 'work',
      order: 0,
      kind: 'prompt',
      title: { ru: 'Прочитай тикет', en: 'Прочитай тикет' },
      prompt: { ru: 'Открой задачу', en: 'Открой задачу' },
      gate: { ru: 'Критерии выписаны', en: 'Критерии выписаны' },
      needsTranslation: true,
    });
    expect(steps[1]).not.toHaveProperty('gate');
    for (const step of steps) expect(pathStepSchema.safeParse(step).success).toBe(true);
  });

  it('no scenario → no steps', () => {
    expect(migrateScenarioSteps(undefined, 'now', String)).toEqual([]);
  });
});

describe('group scope contracts', () => {
  it('a group written before scopes reads as global', () => {
    const old = groupSchema.parse({ id: 'g1', name: 'Team' });
    expect(scopeOf(old)).toEqual({ kind: 'global' });
    expect(groupKeyOf(old)).toBe('global:g1');
  });

  it('a project group keys as project:<id> and round-trips', () => {
    const group = groupSchema.parse({
      id: 'g2',
      name: 'Delivery',
      scope: { kind: 'project', path: 'c:/work/p' },
    });
    expect(group.scope).toEqual({ kind: 'project', path: 'c:/work/p', provider: 'claude' });
    expect(parseGroupKey(groupKeyOf(group))).toEqual({ kind: 'project', id: 'g2' });
  });

  it('a key without a known scope prefix is refused', () => {
    expect(parseGroupKey('g1')).toBeNull();
    expect(parseGroupKey('local:g1')).toBeNull();
    expect(parseGroupKey('global:')).toBeNull();
  });
});

describe('chat group settings', () => {
  it('a root chat defaults to auto + autonomous, nothing inherited', () => {
    expect(resolveChatGroupSettings(undefined, undefined)).toEqual({
      groupChoice: 'auto',
      groupChoiceInherited: false,
      autonomous: true,
      autonomousInherited: false,
    });
  });

  it('a child takes the parent values and says so', () => {
    const parent = resolveChatGroupSettings(
      { groupChoice: 'global:g1', autonomous: false },
      undefined,
    );
    expect(resolveChatGroupSettings(undefined, parent, 'p1')).toEqual({
      groupChoice: 'global:g1',
      groupChoiceInherited: true,
      autonomous: false,
      autonomousInherited: true,
      parentChatId: 'p1',
    });
  });

  it("a child's own value overrides only that field", () => {
    const parent = resolveChatGroupSettings({ groupChoice: 'global:g1' }, undefined);
    const child = resolveChatGroupSettings({ autonomous: false }, parent, 'p1');
    expect(child.groupChoice).toBe('global:g1');
    expect(child.groupChoiceInherited).toBe(true);
    expect(child.autonomous).toBe(false);
    expect(child.autonomousInherited).toBe(false);
    // И наоборот: своя группа у ребёнка — не «из родителя».
    const own = resolveChatGroupSettings({ groupChoice: 'global:g2' }, parent, 'p1');
    expect(own.groupChoice).toBe('global:g2');
    expect(own.groupChoiceInherited).toBe(false);
  });
});

describe('autonomous pick', () => {
  const ask = (options: string[], header = 'Scope') => ({
    questions: [{ question: 'Which scope?', header, options: options.map((label) => ({ label })) }],
  });

  it('takes the option marked (Recommended), not the first one', () => {
    expect(pickRecommended(ask(['Narrow', 'Wide (Recommended)']))).toEqual([
      { question: 'Which scope?', label: 'Wide (Recommended)', critical: false },
    ]);
  });

  it('no recommendation on any question → the whole call goes to the human', () => {
    expect(pickRecommended(ask(['Narrow', 'Wide']))).toBeNull();
    const mixed = {
      questions: [...ask(['A (Recommended)']).questions, ...ask(['B', 'C']).questions],
    };
    expect(pickRecommended(mixed)).toBeNull();
    expect(pickRecommended({})).toBeNull();
    expect(pickRecommended(null)).toBeNull();
  });

  it('a question headed critical is flagged for the main chat', () => {
    expect(pickRecommended(ask(['Stop (Recommended)'], 'Critical'))?.[0]?.critical).toBe(true);
  });

  it('the refusal text carries the marker and every pick', () => {
    const text = autonomousPickMessage([{ question: 'Q1', label: 'L1', critical: false }]);
    expect(text.startsWith(AUTONOMOUS_PICK_MARKER)).toBe(true);
    // Вопрос и выбор — строками JSON: кавычка или стрелка в тексте не ломают разбор (F-132).
    expect(text).toContain('"Q1" → "L1"');
  });
});
