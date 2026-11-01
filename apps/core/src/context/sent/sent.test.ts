import { describe, expect, it } from 'vitest';
import { BriefOverBudget, buildBrief } from '../brief/brief.ts';
import type { BriefPart } from '../brief/brief.types.ts';
import { platformRulesPart } from '../brief/sections.ts';
import { DELTA_TAG, deltaOf, sentAfter } from './sent.ts';

/**
 * Набор отданного и дельта (03 §Context, P13): секция, отданная этой сессии с тем же отпечатком,
 * второй раз не уходит — и правила ядра (`reminder`) тоже; изменённая уходит сообщением с меткой
 * платформы.
 */

const part = (id: BriefPart['id'], text: string): BriefPart => ({ id, text, from: 'test' });

function sentOfBrief(parts: BriefPart[], kind: string): Record<string, string> {
  const brief = buildBrief(parts, kind);
  return sentAfter({}, brief.placed);
}

describe('deltaOf', () => {
  const rules = platformRulesPart('work', '.agentdeck/notebook.agent.md')!;
  const first = [part('task', 'T'), part('step', 'do it'), rules, part('handoff', 'files: a.ts')];

  it('nothing changed since the brief: no message at all', () => {
    expect(deltaOf(sentOfBrief(first, 'work'), first, 'work')).toBeNull();
  });

  it('only the changed section goes, platform-marked; the core rules already sent are not re-sent', () => {
    const sent = sentOfBrief(first, 'work');
    const next = [
      part('task', 'T'),
      part('step', 'do it'),
      rules,
      part('handoff', 'files: a.ts, b.ts'),
    ];
    const delta = deltaOf(sent, next, 'work')!;
    expect(delta.sections.map((s) => s.id)).toEqual(['handoff']);
    expect(delta.kept).toEqual(['task', 'step', 'reminder']);
    expect(delta.text.startsWith(`<${DELTA_TAG}>Platform update, not a human message`)).toBe(true);
    expect(delta.text).toContain('## handoff\nfiles: a.ts, b.ts');
    expect(delta.text).not.toContain('## step');
    expect(delta.text).not.toContain('## reminder');
  });

  it('a new section (not sent before) goes; after it is recorded the same text never goes again', () => {
    const sent = sentOfBrief(first, 'work');
    const withFailing = [...first, part('failing', 'unit tests: 2 red')];
    const delta = deltaOf(sent, withFailing, 'work')!;
    expect(delta.sections.map((s) => s.id)).toEqual(['failing']);
    expect(deltaOf(sentAfter(sent, delta.sections), withFailing, 'work')).toBeNull();
  });

  it('the delta is masked at its own sink', () => {
    const key = `ghp_${'b'.repeat(36)}`;
    const delta = deltaOf({}, [part('handoff', `token ${key}`)], 'work')!;
    expect(delta.text).not.toContain(key);
    expect(delta.masked).toBe(1);
  });

  it('a changed section over its bin fails the delta like the brief', () => {
    expect(() => deltaOf({}, [part('knowledge', 'k'.repeat(1200))], 'work')).toThrow(
      BriefOverBudget,
    );
  });

  it('sentAfter keeps the latest fingerprint per section', () => {
    expect(
      sentAfter({ a: '1', b: '2' }, [
        { id: 'b', sha256: '3', bytes: 1 },
        { id: 'c', sha256: '4', bytes: 1 },
      ]),
    ).toEqual({ a: '1', b: '3', c: '4' });
  });
});
