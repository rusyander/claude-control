import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { chatWatchSignalsOf, type GroupSignal } from '@agentdeck/contracts/group-watch';
import { queryKeys } from '@shared/api/query-keys';
import { i18n } from '@shared/config/i18n';
import { ChatWatchIsland } from './ChatWatchIsland';

/**
 * Остров сторожа над лентой одиночного чата: список приходит в кэш запроса так,
 * как его разбирает хук (`chatWatchSignalsOf`), отрисовка — настоящий
 * `GroupSignals` в режиме чата. Ключи — id чата панели и id сессии CLI.
 */
const signal = (id: string, over: Partial<GroupSignal> = {}): GroupSignal => ({
  id,
  rule: 'R27',
  severity: 'alert',
  groupIndex: -1,
  chatId: 'chat-1',
  at: '2026-10-23T10:00:00.000Z',
  numbers: { waitMin: 64 },
  textKey: 'groupWatch.rule.R27',
  params: { question: 'Оставить старый формат?' },
  ...over,
});

function render(raw: unknown, chatId?: string, sessionId?: string): string {
  const client = new QueryClient();
  client.setQueryData(queryKeys.chatWatchSignals, chatWatchSignalsOf(raw));
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ChatWatchIsland {...(chatId ? { chatId } : {})} {...(sessionId ? { sessionId } : {})} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('ChatWatchIsland — остров сторожа одиночного чата', () => {
  const raw = {
    signals: {
      'chat-1': [signal('a')],
      'session-1': [
        signal('a'),
        signal('b', {
          rule: 'R24',
          severity: 'warn',
          numbers: { fails: 3 },
          textKey: 'groupWatch.rule.R24',
          params: { call: 'pnpm vitest run' },
        }),
      ],
      other: [signal('c', { chatId: 'other' })],
    },
  };

  it('сигналы по обоим ключам, один раз каждый, без ссылки на тот же чат', () => {
    const html = render(raw, 'chat-1', 'session-1');
    expect(html).toContain('data-chat-watch="2"');
    expect(html).toContain('data-watch-scope="chat"');
    expect(html).toContain('>Сторож чата<');
    expect(html.match(/data-watch-signal="R27"/g)).toHaveLength(1);
    expect(html).toContain('data-watch-signal="R24"');
    expect(html).toContain('Ход кончился вопросом в тексте, без карточки, — ждёт ответа 64 мин');
    expect(html).not.toContain('data-watch-open');
  });

  it('у чата нет сигналов или чат не открыт — острова нет', () => {
    expect(render(raw, 'quiet')).toBe('');
    expect(render(raw)).toBe('');
    expect(render(undefined, 'chat-1')).toBe('');
  });

  // F-72: после rekey сигнал лежит под id сессии, страница ещё на `new-…`.
  // Тот же сигнал строка списка видит по `chat.id` (= id сессии) —
  // ChatList.watch.render.test.tsx.
  it('чат ещё под new-…, сигнал переехал на id сессии — остров его показывает', () => {
    const html = render({ signals: { 'session-9': [signal('z')] } }, 'new-9', 'session-9');
    expect(html).toContain('data-chat-watch="1"');
  });

  it('закрытый сигнал сервера другой версии не зажигает остров', () => {
    const html = render(
      { signals: { 'chat-1': [{ ...signal('a'), clearedAt: '2026-10-23T11:00:00.000Z' }] } },
      'chat-1',
    );
    expect(html).toBe('');
  });
});
