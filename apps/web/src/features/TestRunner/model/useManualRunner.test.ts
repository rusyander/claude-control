import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ProjectTestManualSession, ProjectTestSharedStep } from '@agentdeck/contracts';
import {
  formatElapsed,
  patchStepResult,
  resolveSteps,
  savedFor,
  toBase64,
} from './useManualRunner';

/**
 * Тестировщик и агент обязаны видеть один и тот же текст шага: общие шаги
 * раскрыты, значения параметров подставлены. Разойдись это — и человек отметит
 * «прошло» по не тому, что проверял агент.
 */
const shared: ProjectTestSharedStep[] = [
  {
    id: 'login',
    title: 'Вход',
    steps: [
      { action: 'открыть панель' },
      { action: 'войти как %role', expected: 'виден раздел %role' },
    ],
  },
];

describe('resolveSteps', () => {
  it('раскрывает общий шаг и подставляет значения параметров', () => {
    const steps = resolveSteps(
      [
        { action: '', ref: 'login' },
        { action: 'открыть %area', data: 'ветка %branch' },
      ],
      shared,
      { role: 'admin', area: 'чат', branch: 'main' },
    );

    expect(steps).toEqual([
      { action: 'открыть панель' },
      { action: 'войти как admin', expected: 'виден раздел admin' },
      { action: 'открыть чат', data: 'ветка main' },
    ]);
  });

  it('незаданный параметр остаётся на виду, а не подставляется пустотой', () => {
    expect(resolveSteps([{ action: 'войти как %role' }], [], {})).toEqual([
      { action: 'войти как %role' },
    ]);
  });

  it('ссылка на несуществующий общий шаг остаётся строкой, кейс не рушится', () => {
    // Ссылка на экран не выносится: человеку показывают шаги, а не устройство
    // файла. Неизвестная ссылка вырождается в собственную подпись шага.
    expect(resolveSteps([{ action: 'подпись', ref: 'нет-такого' }], shared)).toEqual([
      { action: 'подпись' },
    ]);
  });

  it('кейса ещё нет — шагов нет', () => {
    expect(resolveSteps(undefined, shared)).toEqual([]);
  });
});

describe('formatElapsed', () => {
  it('показывает минуты и секунды с ведущими нулями', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(9_000)).toBe('00:09');
    expect(formatElapsed(75_000)).toBe('01:15');
    expect(formatElapsed(3_600_000)).toBe('60:00');
  });

  it('часы обратно не отматываются: отрицательное время — это ноль', () => {
    expect(formatElapsed(-5_000)).toBe('00:00');
  });
});

describe('savedFor', () => {
  const session: ProjectTestManualSession = {
    runId: 'run-1',
    points: [],
    index: 0,
    startedAt: '2026-09-07T10:00:00.000Z',
    results: [
      {
        pointId: 'p1',
        groupId: 'gui',
        caseId: 'a',
        status: 'failed',
        note: 'кнопка не нажимается',
        steps: [{ index: 0, status: 'failed' }],
        attachments: ['shot.png'],
      },
    ],
  };

  it('возвращает отметки того поинта, на который перешли', () => {
    expect(savedFor(session, 'p1')).toEqual({
      steps: [{ index: 0, status: 'failed' }],
      note: 'кнопка не нажимается',
      attachments: ['shot.png'],
    });
  });

  it('нетронутый поинт открывается чистым — чужая заметка на него не приезжает', () => {
    expect(savedFor(session, 'p2')).toEqual({ steps: [], note: '', attachments: [] });
    expect(savedFor(undefined, 'p1')).toEqual({ steps: [], note: '', attachments: [] });
  });
});

describe('patchStepResult', () => {
  it('заводит отметку по новому шагу со статусом «нет»', () => {
    expect(patchStepResult([], 1, { note: 'подвисло' })).toEqual([
      { index: 1, status: 'unknown', note: 'подвисло' },
    ]);
  });

  it('дописывает существующую отметку, не трогая соседние', () => {
    const before = [
      { index: 0, status: 'passed' as const },
      { index: 1, status: 'unknown' as const, note: 'подвисло' },
    ];
    const after = patchStepResult(before, 1, { status: 'failed' });
    expect(after).toEqual([
      { index: 0, status: 'passed' },
      { index: 1, status: 'failed', note: 'подвисло' },
    ]);
    expect(before[1]?.status).toBe('unknown');
  });
});

/**
 * `FileReader` — браузерный объект, в node его нет. Подменяется ровно тем, что
 * от него нужно: `readAsDataURL` и два исхода, потому что проверяется не сам
 * ридер, а отрезание префикса `data:` — с ним сервер получил бы мусор вместо
 * скриншота.
 */
class FakeReader {
  public result: string | null = null;
  public error: Error | null = null;
  public onload: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public static failure: Error | null = null;

  public readAsDataURL(file: { text: () => Promise<string> }): void {
    if (FakeReader.failure) {
      this.error = FakeReader.failure;
      this.onerror?.();
      return;
    }
    void file.text().then((text) => {
      this.result = `data:text/plain;base64,${Buffer.from(text, 'utf8').toString('base64')}`;
      this.onload?.();
    });
  }
}

describe('toBase64', () => {
  const original = (globalThis as { FileReader?: unknown }).FileReader;

  beforeEach(() => {
    FakeReader.failure = null;
    (globalThis as { FileReader?: unknown }).FileReader = FakeReader;
  });

  afterEach(() => {
    (globalThis as { FileReader?: unknown }).FileReader = original;
  });

  it('отдаёт содержимое без префикса data:', async () => {
    const file = new File(['привет'], 'shot.txt', { type: 'text/plain' });
    await expect(toBase64(file)).resolves.toBe(Buffer.from('привет', 'utf8').toString('base64'));
  });

  it('нечитаемый файл роняет вложение, а не молча даёт пустое', async () => {
    FakeReader.failure = new Error('read failed');
    const file = new File(['x'], 'shot.txt', { type: 'text/plain' });
    await expect(toBase64(file)).rejects.toThrow('read failed');
  });
});
