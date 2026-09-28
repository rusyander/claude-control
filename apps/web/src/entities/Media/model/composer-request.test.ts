import { describe, expect, it, vi } from 'vitest';
import {
  COMPOSER_REQUEST_TTL_MS,
  onComposerModeRequest,
  requestComposerMode,
  takeComposerMode,
} from './composer-request';

describe('composer-request', () => {
  it('просьба забирается один раз: второй показ чата режим не навязывает', () => {
    requestComposerMode('deck');
    expect(takeComposerMode('chat')).toBe('deck');
    expect(takeComposerMode('chat')).toBeUndefined();
  });

  // Ревью 26.09: живой композер чужого CLI забирал «Презентацию», и чат Claude,
  // открытый агентом следом, начинался с «Сообщения».
  it('композер чата чужого CLI просьбу не забирает — она ждёт чат Claude', () => {
    requestComposerMode('deck');
    expect(takeComposerMode('provider-chat')).toBeUndefined();
    expect(takeComposerMode('chat')).toBe('deck');
  });

  it('живой композер узнаёт о просьбе сигналом, отписанный — нет', () => {
    const listener = vi.fn();
    const off = onComposerModeRequest(listener);
    requestComposerMode('image');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    requestComposerMode('deck');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(takeComposerMode('chat')).toBe('deck');
  });

  // Ревью 28.09 (F-192): агент открыл чат при активном чужом CLI — просьбу никто
  // не забрал, и чат Claude, открытый человеком много позже, начинался с
  // «Презентации». Просьба живёт, пока идёт переход, а не до следующего чата.
  it('невостребованная просьба истекает и позже чат Claude не перехватывает', () => {
    requestComposerMode('deck', 1_000);
    expect(takeComposerMode('provider-chat', 1_500)).toBeUndefined();
    expect(takeComposerMode('chat', 1_000 + COMPOSER_REQUEST_TTL_MS + 1)).toBeUndefined();
    requestComposerMode('image', 5_000);
    expect(takeComposerMode('chat', 5_000 + COMPOSER_REQUEST_TTL_MS)).toBe('image');
  });
});
