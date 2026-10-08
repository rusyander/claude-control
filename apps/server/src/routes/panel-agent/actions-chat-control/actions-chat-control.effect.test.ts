import { describe, it, expect } from 'vitest';
import { controlEffect } from './actions-chat-control.ts';

/** Карточка пульта говорит, что будет, по тому, где группа стоит (ревью 29.09, A14/N7/R5). */
describe('controlEffect', () => {
  it.each([
    [
      'продолжить паузу из очереди — обратно в очередь',
      'resume_group',
      { status: 'paused' },
      'value-split-requeue-effect',
    ],
    [
      'продолжить паузу с местом, но без чата — старт в копии',
      'resume_group',
      { status: 'paused', seated: true },
      'value-split-resume-fresh-effect',
    ],
    [
      'продолжить паузу с чатом — своей сессией',
      'resume_group',
      { status: 'paused', seated: true, chatId: 'c' },
      'value-split-resume-effect',
    ],
    [
      'пауза группы из очереди — прогонов нет',
      'pause_group',
      { status: 'pending' },
      'value-split-pause-queued-effect',
    ],
    [
      'пауза работающей — прогоны остановятся',
      'pause_group',
      { status: 'started', seated: true, chatId: 'c' },
      'value-split-pause-effect',
    ],
  ] as const)('%s', (_name, mode, group, code) => {
    expect(controlEffect(mode, group)).toBe(code);
  });
});
