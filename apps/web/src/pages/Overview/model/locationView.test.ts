import { describe, it, expect } from 'vitest';
import type { ClaudeLocation } from '@agentdeck/contracts';
import { locationView } from './locationView';

const location = (isValid: boolean) =>
  ({ isValid, missing: [], paths: {} }) as unknown as ClaudeLocation;

describe('каталог Claude на «Обзоре»', () => {
  it('каталог есть — зелёный, строки о файлах показываются', () => {
    expect(locationView(location(true), false)).toEqual({
      tone: 'success',
      claudeUnused: false,
      showProblems: true,
    });
  });

  it('каталога нет, а работает Claude — красный «не найден»', () => {
    expect(locationView(location(false), true)).toMatchObject({
      tone: 'danger',
      claudeUnused: false,
    });
  });

  it('каталога нет при другом провайдере — нейтрально, «Claude не используется», без строк сбоя', () => {
    expect(locationView(location(false), false)).toEqual({
      tone: 'neutral',
      claudeUnused: true,
      showProblems: false,
    });
  });
});
