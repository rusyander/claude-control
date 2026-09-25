import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MessageUsage } from '@agentdeck/contracts';
import type { StreamState } from '@shared/lib/chat-stream';
import { ChatMessages } from './ChatMessages';
import type { ChatMessagesProps } from './ChatMessages.types';

/**
 * Расход шага в живом пузыре (находка 3 журнала 24.09.2026). CLI пишет строку на
 * КАЖДЫЙ блок хода с одним и тем же расходом, и шаг из трёх вызовов показывал
 * «+42.4k» трижды — в ленте это читалось как втрое больший расход. История
 * сводит блоки хода по `message.id` и ставит бейдж один раз (`MessageBubble`,
 * `spendIndex`); живой поток обязан делать так же. Проверяется сама разметка
 * ленты, а не правило отдельно.
 */

const STEP: MessageUsage = { input: 100, output: 200, cacheRead: 42_000, cacheCreation: 100 };
const OTHER: MessageUsage = { input: 10, output: 20, cacheRead: 1000, cacheCreation: 0 };

function render(tools: StreamState['tools']): string {
  const stream: StreamState = { text: '', thinking: '', tools, isRunning: true };
  const props = {
    messages: [],
    stream,
    isLoading: false,
  } as unknown as ChatMessagesProps;
  return renderToStaticMarkup(<ChatMessages {...props} />);
}

const badges = (html: string): number => html.match(/aria-controls=/g)?.length ?? 0;

describe('живой поток — расход шага один раз на шаг', () => {
  it('три вызова одного шага — один бейдж, у первого вызова', () => {
    const html = render([
      { name: 'Read', input: '{}', id: 't1', usage: STEP },
      { name: 'Grep', input: '{}', id: 't2', usage: STEP },
      { name: 'Bash', input: '{}', id: 't3', usage: STEP },
    ]);

    expect(badges(html)).toBe(1);
    // Бейдж стоит у первого вызова шага: он раньше имени второго в разметке.
    expect(html.indexOf('aria-controls=')).toBeLessThan(html.indexOf('Grep'));
  });

  it('два шага — по бейджу на каждый', () => {
    const html = render([
      { name: 'Read', input: '{}', id: 't1', usage: STEP },
      { name: 'Grep', input: '{}', id: 't2', usage: STEP },
      { name: 'Bash', input: '{}', id: 't3', usage: OTHER },
    ]);

    expect(badges(html)).toBe(2);
  });

  it('вызов, чей расход ещё не пришёл, бейджа не получает', () => {
    const html = render([
      { name: 'Read', input: '{}', id: 't1', usage: STEP },
      { name: 'Grep', input: '{}', id: 't2' },
    ]);

    expect(badges(html)).toBe(1);
  });
});
