import { describe, it, expect } from 'vitest';
import type { PermissionRule } from '@claude-control/contracts';
import { coversPattern, shadowedBy, effectiveRuleFor, findDuplicate } from './effectiveDecision';

const rule = (
  decision: PermissionRule['decision'],
  pattern: string,
  source: PermissionRule['source'] = 'settings',
): PermissionRule => ({
  id: `${source === 'settings-local' ? 'local:' : ''}${decision}:${pattern}`,
  pattern,
  decision,
  groupIds: [],
  source,
  isEnabled: true,
});

describe('coversPattern — какой шаблон накрывает какой', () => {
  it('тот же шаблон, голый инструмент и сервер целиком', () => {
    expect(coversPattern('Bash(rm:*)', 'Bash(rm:*)')).toBe(true);
    expect(coversPattern('Bash', 'Bash(rm:*)')).toBe(true);
    expect(coversPattern('mcp__srv', 'mcp__srv__tool')).toBe(true);
    expect(coversPattern('mcp__my_srv', 'mcp__my_srv__tool')).toBe(true);
  });

  it('уточнение не накрывает соседнее, инструмент не накрывает чужой сервер', () => {
    expect(coversPattern('Bash(rm:*)', 'Bash(git status:*)')).toBe(false);
    expect(coversPattern('Bash(rm:*)', 'Bash')).toBe(false);
    expect(coversPattern('mcp__srv__tool', 'mcp__srv__other')).toBe(false);
    expect(coversPattern('mcp__srv', 'mcp__srv2__tool')).toBe(false);
    expect(coversPattern('Bash', 'Bashful')).toBe(false);
  });
});

describe('shadowedBy — что перекрывает правило', () => {
  const rules = [
    rule('allow', 'Bash(rm:*)'),
    rule('deny', 'Bash(rm:*)'),
    rule('allow', 'Bash(git status:*)'),
    rule('ask', 'Bash', 'settings-local'),
    rule('allow', 'mcp__srv__tool'),
    rule('deny', 'mcp__srv'),
  ];

  it('deny того же шаблона гасит allow, обратное — нет', () => {
    expect(shadowedBy(rules[0]!, rules)?.id).toBe('deny:Bash(rm:*)');
    expect(shadowedBy(rules[1]!, rules)).toBeUndefined();
  });

  it('берётся самое сильное из накрывающих, локальный файл считается', () => {
    expect(shadowedBy(rules[2]!, rules)?.id).toBe('local:ask:Bash');
    expect(shadowedBy(rules[4]!, rules)?.id).toBe('deny:mcp__srv');
  });
});

describe('effectiveRuleFor — что действует для заготовки', () => {
  it('точное совпадение важнее широкого при равной силе, сильное важнее точного', () => {
    const rules = [rule('allow', 'Bash'), rule('allow', 'Bash(rm:*)'), rule('deny', 'Bash')];
    expect(effectiveRuleFor('Bash(rm:*)', rules)?.id).toBe('deny:Bash');
    expect(effectiveRuleFor('Bash(rm:*)', rules.slice(0, 2))?.id).toBe('allow:Bash(rm:*)');
    expect(effectiveRuleFor('Read', rules)).toBeUndefined();
  });
});

describe('findDuplicate — тот же файл, тот же шаблон, то же решение', () => {
  const rules = [rule('allow', 'Read'), rule('allow', 'Read', 'settings-local')];

  it('находит дубль в своём файле и пропускает правимое правило', () => {
    expect(
      findDuplicate({ pattern: 'Read', decision: 'allow', source: 'settings' }, rules)?.id,
    ).toBe('allow:Read');
    expect(
      findDuplicate(
        { pattern: 'Read', decision: 'allow', source: 'settings' },
        rules,
        'allow:Read',
      ),
    ).toBeUndefined();
    expect(
      findDuplicate({ pattern: 'Read', decision: 'deny', source: 'settings' }, rules),
    ).toBeUndefined();
  });
});
