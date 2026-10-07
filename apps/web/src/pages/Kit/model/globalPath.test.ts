import { describe, expect, it } from 'vitest';
import { insideGlobal } from './globalPath';

describe('insideGlobal', () => {
  it('Windows: разделители и регистр диска не мешают', () => {
    expect(
      insideGlobal('C:\\Users\\me\\.claude\\skills\\x\\SKILL.md', 'c:\\Users\\me\\.claude\\'),
    ).toBe('skills/x/SKILL.md');
  });

  it('POSIX: путь внутри папки', () => {
    expect(insideGlobal('/home/me/.claude/agents/a.md', '/home/me/.claude')).toBe('agents/a.md');
  });

  it('чужой путь и соседняя папка с тем же началом — как есть', () => {
    expect(insideGlobal('/home/me/.claude-old/a.md', '/home/me/.claude')).toBe(
      '/home/me/.claude-old/a.md',
    );
    expect(insideGlobal('/elsewhere/a.md', '/home/me/.claude')).toBe('/elsewhere/a.md');
    expect(insideGlobal('/a.md', '')).toBe('/a.md');
  });
});
