import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatSummary } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { ChatRow } from './ChatRow';

/**
 * Ветка правки своей реплики в списке (Telegram 26.10, R2): у неё та же история
 * и то же название, что у исходного разговора, и без подписи в списке стояли
 * два одинаковых чата — человек не знал, в котором группы и закрепление.
 */

const chat = (extra: Partial<ChatSummary> = {}): ChatSummary =>
  ({
    id: 'fork-1',
    title: 'Перенос среды между CLI',
    project: 'proj',
    projectPath: '/work/proj',
    isSandbox: false,
    updatedAt: '2026-10-26T10:00:00.000Z',
    createdAt: '2026-10-26T09:00:00.000Z',
    messageCount: 108,
    ...extra,
  }) as ChatSummary;

const render = (summary: ChatSummary, snippet?: string): string =>
  renderToStaticMarkup(
    <ChatRow
      chat={summary}
      isActive={false}
      language="ru"
      onSelect={() => {}}
      {...(snippet ? { snippet, query: 'среды' } : {})}
    />,
  );

/** Текст без разметки: подпись собрана из нескольких узлов. */
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");

describe('строка списка чатов — ветка правки реплики', () => {
  it('ветка подписана названием исходного разговора, на месте имени проекта', () => {
    const html = text(render(chat({ forkOf: { id: 'origin', title: 'Перенос среды между CLI' } })));

    expect(html).toContain(i18n.t('chat.fork.of', { title: 'Перенос среды между CLI' }));
    expect(html).toContain('ветка от «Перенос среды между CLI»');
  });

  it('исходного нет в списке — подпись без названия', () => {
    const html = text(render(chat({ forkOf: { id: 'origin' } })));

    expect(html).toContain(i18n.t('chat.fork.ofUnknown'));
  });

  it('обычный разговор — без подписи ветки', () => {
    const html = text(render(chat()));

    expect(html).not.toContain('ветка от');
    expect(html).not.toContain(i18n.t('chat.fork.ofUnknown'));
    expect(html).toContain('proj');
  });
});
