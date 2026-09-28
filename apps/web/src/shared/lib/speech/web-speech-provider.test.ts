import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechErrorKind } from './speech-provider';
import {
  PROMPT_GRACE_MS,
  START_WATCHDOG_MS,
  STOP_WATCHDOG_MS,
  WebSpeechProvider,
} from './web-speech-provider';

/** Распознаватель, который делает только то, что велит тест. */
class FakeRecognition {
  static last: FakeRecognition | undefined;
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onstart: (() => void) | null = null;
  onaudiostart: (() => void) | null = null;
  stops = 0;
  constructor() {
    FakeRecognition.last = this;
  }
  start(): void {}
  stop(): void {
    this.stops += 1;
  }
}

function provider() {
  const speech = new WebSpeechProvider();
  const errors: SpeechErrorKind[] = [];
  let ends = 0;
  speech.onError((kind) => errors.push(kind));
  speech.onEnd(() => {
    ends += 1;
  });
  return { speech, errors, ends: () => ends };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { SpeechRecognition: FakeRecognition });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('[C1] распознаватель, который не отвечает', () => {
  it('ни одного события после start — «нет микрофона» и конец сессии, а не «Говорите…» навсегда', () => {
    const { speech, errors, ends } = provider();
    speech.start('ru-RU');
    vi.advanceTimersByTime(START_WATCHDOG_MS - 1);
    expect(errors).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(errors).toEqual(['no-microphone']);
    expect(ends()).toBe(1);
  });

  it('распознаватель ответил start — сторож молчит, тишина в эфире не ошибка', () => {
    const { speech, errors, ends } = provider();
    speech.start('ru-RU');
    FakeRecognition.last?.onstart?.();
    vi.advanceTimersByTime(START_WATCHDOG_MS * 2);
    expect(errors).toEqual([]);
    expect(ends()).toBe(0);
  });

  it('audio-capture — нет устройства записи, говорим об этом, а не молчим', () => {
    const { speech, errors } = provider();
    speech.start('ru-RU');
    FakeRecognition.last?.onerror?.({ error: 'audio-capture' });
    expect(errors).toEqual(['no-microphone']);
  });

  it('stop без конца сессии — микрофон отпускается сам, «Перевожу речь…» не висит', () => {
    const { speech, errors, ends } = provider();
    speech.start('ru-RU');
    FakeRecognition.last?.onstart?.();
    speech.stop();
    vi.advanceTimersByTime(STOP_WATCHDOG_MS - 1);
    expect(ends()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(ends()).toBe(1);
    expect(errors).toEqual([]);
  });

  it('stop с настоящим концом сессии — конец один, сторож не досылает второй', () => {
    const { speech, ends } = provider();
    speech.start('ru-RU');
    const recognition = FakeRecognition.last;
    recognition?.onstart?.();
    speech.stop();
    recognition?.onend?.();
    vi.advanceTimersByTime(STOP_WATCHDOG_MS * 2);
    expect(ends()).toBe(1);
  });
});

describe('браузер спрашивает доступ к микрофону (F-335)', () => {
  it('пока вопрос о доступе открыт, сторож старта не объявляет «нет микрофона»', async () => {
    const status = { state: 'prompt' as PermissionState };
    vi.stubGlobal('navigator', { permissions: { query: () => Promise.resolve(status) } });
    const { speech, errors, ends } = provider();
    speech.start('ru-RU');
    await vi.advanceTimersByTimeAsync(START_WATCHDOG_MS * 3);
    expect(errors).toEqual([]);
    expect(ends()).toBe(0);
    // Человек ответил, а распознаватель так и молчит — теперь это «нет микрофона».
    status.state = 'granted';
    await vi.advanceTimersByTimeAsync(START_WATCHDOG_MS);
    expect(errors).toEqual(['no-microphone']);
    expect(ends()).toBe(1);
  });

  // Без устройства записи Chromium вопроса не показывает вовсе, а `state` так и
  // остаётся 'prompt': ожидание ответа без предела вернуло «Говорите…» навсегда
  // (check-panel-agent-window, 29.09).
  it('вопрос, на который никто не ответил за отведённый срок, — «нет микрофона», а не вечное ожидание', async () => {
    const status = { state: 'prompt' as PermissionState };
    vi.stubGlobal('navigator', { permissions: { query: () => Promise.resolve(status) } });
    const { speech, errors, ends } = provider();
    speech.start('ru-RU');
    await vi.advanceTimersByTimeAsync(PROMPT_GRACE_MS - 1);
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toEqual(['no-microphone']);
    expect(ends()).toBe(1);
  });

  it('без Permissions API — прежний срок', async () => {
    vi.stubGlobal('navigator', {});
    const { speech, errors } = provider();
    speech.start('ru-RU');
    await vi.advanceTimersByTimeAsync(START_WATCHDOG_MS);
    expect(errors).toEqual(['no-microphone']);
  });
});

describe('поле ушло со страницы (F-342)', () => {
  it('dispose: ни сторожей, ни колбэков ушедшего хука', () => {
    const { speech, errors, ends } = provider();
    speech.start('ru-RU');
    const recognition = FakeRecognition.last;
    recognition?.onstart?.();
    speech.dispose();
    expect(recognition?.stops).toBe(1);
    vi.advanceTimersByTime(STOP_WATCHDOG_MS * 2);
    recognition?.onend?.();
    expect(ends()).toBe(0);
    expect(errors).toEqual([]);
  });
});
