import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatSummary } from '@agentdeck/contracts';
import { chatWatchSignalsOf, type GroupSignal } from '@agentdeck/contracts/group-watch';
import { queryKeys } from '@shared/api/query-keys';
import { i18n } from '@shared/config/i18n';
import { ChatList } from './ChatList';

/**
 * Метка сторожа в строке списка после переезда ключа (F-72). Первый ход чата
 * заведён под временным `new-…`; родилась сессия — сторож переносит сигналы
 * на её id (`GroupWatcher.rekey` → `SignalRecorder.moveChat`). Список знает
 * разговор по id транскрипта, то есть по тому же id сессии, и ищет сигналы
 * только по `chat.id`, остров чата — по обоим ключам. Сигнал под id сессии
 * обязан быть виден и в строке списка, а не только на острове.
 */

const signal = (id: string, chatId: string): GroupSignal => ({
  id,
  rule: 'R27',
  severity: 'alert',
  groupIndex: -1,
  chatId,
  at: '2026-10-23T10:00:00.000Z',
  numbers: { waitMin: 64 },
  textKey: 'groupWatch.rule.R27',
  params: { question: 'Оставить старый формат?' },
});

const chat = (id: string): ChatSummary =>
  ({
    id,
    title: 'Чат с вопросом',
    project: 'proj',
    projectPath: '/proj',
    updatedAt: '2026-10-23T10:00:00.000Z',
    messageCount: 3,
  }) as ChatSummary;

function render(raw: unknown, chats: ChatSummary[]): string {
  const client = new QueryClient();
  client.setQueryData(queryKeys.chatWatchSignals, chatWatchSignalsOf(raw));
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ChatList chats={chats} isLoading={false} onSelect={() => {}} onCreate={() => {}} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('ChatList — метка сторожа по ключу после переезда (F-72)', () => {
  it('сигнал под id сессии (после rekey new-… → сессия) — метка в строке этого чата', () => {
    const html = render({ signals: { 'session-1': [signal('a', 'session-1')] } }, [
      chat('session-1'),
    ]);

    expect(html).toContain('data-chat-watch-count="1"');
    expect(html).toContain('data-chat-watch-severity="alert"');
  });

  it('сигнал другого чата строку не метит', () => {
    const html = render({ signals: { 'session-2': [signal('a', 'session-2')] } }, [
      chat('session-1'),
    ]);

    expect(html).not.toContain('data-chat-watch-count');
  });
});
