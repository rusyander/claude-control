import { describe, expect, it } from 'vitest';
import { appendDictation, isDictating, isVoiceProblem, voiceView } from './voiceInput';

const base = { state: 'idle', supported: true, error: null, attempted: false } as const;

describe('микрофон окна агента', () => {
  it('без поддержки молчит до попытки и называет причину после неё', () => {
    expect(voiceView({ ...base, supported: false, state: 'unsupported' })).toBe('idle');
    expect(voiceView({ ...base, supported: false, state: 'unsupported', attempted: true })).toBe(
      'unsupported',
    );
  });

  it('запись и финализация — диктовка, отправка ждёт', () => {
    expect(voiceView({ ...base, state: 'listening' })).toBe('listening');
    expect(voiceView({ ...base, state: 'finalizing' })).toBe('finalizing');
    expect(isDictating('listening')).toBe(true);
    expect(isDictating('finalizing')).toBe(true);
    expect(isDictating('idle')).toBe(false);
  });

  it('отказ разрешения, сеть и прочее различаются', () => {
    expect(voiceView({ ...base, state: 'error', error: 'no-permission' })).toBe('denied');
    expect(voiceView({ ...base, state: 'error', error: 'network' })).toBe('network');
    expect(voiceView({ ...base, state: 'error', error: 'unsupported' })).toBe('unsupported');
    expect(voiceView({ ...base, state: 'error', error: 'aborted' })).toBe('error');
    expect(isVoiceProblem('denied')).toBe(true);
    expect(isVoiceProblem('listening')).toBe(false);
    expect(isVoiceProblem('idle')).toBe(false);
  });

  it('надиктованное дописывается к набранному, пустое ничего не меняет', () => {
    expect(appendDictation('', 'создай проект')).toBe('создай проект');
    expect(appendDictation('Перейди в чат,', ' создай проект ')).toBe(
      'Перейди в чат, создай проект',
    );
    expect(appendDictation('текст  ', '')).toBe('текст  ');
  });
});
