import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FeedNotices } from './FeedNotices';
import type { StreamState } from '../../../../shared/lib/chat-stream';

/**
 * R5 ревью П1: под заметкой «ход пошёл новым разговором вместо остывшего» —
 * кнопка вернуть ход в старую сессию. Только у этой заметки, только пока новый
 * разговор идёт (законченный уже сделал работу) и только там, где страница
 * умеет её нажать.
 */

const COLD: StreamState = {
  text: '',
  thinking: '',
  tools: [],
  isRunning: true,
  notice: 'Ход пошёл новым разговором',
  noticeCode: 'chat-cold-resume-notice',
  noticeParams: { tokens: '120', previous: 'old-session' },
};

const BUTTON = /<button[^>]*>[^<]*(Продолжить старый разговор|keepColdSession)/;

const render = (stream: StreamState, onKeepSession?: () => void): string =>
  renderToStaticMarkup(
    <FeedNotices stream={stream} {...(onKeepSession ? { onKeepSession } : {})} />,
  );

describe('FeedNotices — возврат в остывшую сессию', () => {
  it('заметка остывшей сессии у идущего хода — с кнопкой', () => {
    expect(render(COLD, () => {})).toMatch(BUTTON);
  });

  it('ход кончился — кнопки нет', () => {
    expect(render({ ...COLD, isRunning: false }, () => {})).not.toMatch(BUTTON);
  });

  it('другая заметка — кнопки нет', () => {
    expect(render({ ...COLD, noticeCode: 'chat-conversation-lost-notice' }, () => {})).not.toMatch(
      BUTTON,
    );
  });

  it('страница не умеет вернуть ход — кнопки нет, заметка есть', () => {
    const html = render(COLD);
    expect(html).not.toMatch(BUTTON);
    expect(html).toContain('data-chat-notice');
  });
});
