import { describe, it, expect } from 'vitest';
import { supportsCliAutoMode } from './auto-mode.ts';

describe('supportsCliAutoMode', () => {
  it('алиасы и полные имена opus/sonnet/fable у Claude — с авторежимом', () => {
    for (const model of [
      'opus',
      'sonnet',
      'fable',
      'Opus[1m]',
      'claude-sonnet-5',
      'claude-opus-4-7',
    ]) {
      expect(supportsCliAutoMode('claude', model)).toBe(true);
    }
  });

  it('модель не названа — CLI берёт свою, авторежим есть', () => {
    expect(supportsCliAutoMode('claude', '')).toBe(true);
    expect(supportsCliAutoMode('claude', undefined)).toBe(true);
    expect(supportsCliAutoMode('claude', 'default')).toBe(true);
  });

  it('haiku — без авторежима: CLI молча опустил бы его до default', () => {
    expect(supportsCliAutoMode('claude', 'haiku')).toBe(false);
    expect(supportsCliAutoMode('claude', 'claude-haiku-4-5')).toBe(false);
  });

  it('чужой CLI и незнакомая модель — без авторежима', () => {
    expect(supportsCliAutoMode('codex', 'sonnet')).toBe(false);
    expect(supportsCliAutoMode('gemini', '')).toBe(false);
    expect(supportsCliAutoMode('claude', 'gpt-5')).toBe(false);
    expect(supportsCliAutoMode('claude', 'magnum-opus-7b')).toBe(false);
  });
});
