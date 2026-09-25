import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatSummary } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { ChatRow } from './ChatRow';

/**
 * Метки «ждёт вас» и «принято» в строке списка чатов (итоговое ревью 25.09):
 * раньше их показывала только сводка хаба, и в списке ждущий ребёнок и
 * принятая группа читались просто молчащими чатами.
 */

const chat = (extra: Partial<ChatSummary> = {}): ChatSummary =>
  ({
    id: 'g-1',
    title: 'Группа 1',
    project: 'proj',
    projectPath: '/proj',
    updatedAt: '2026-09-25T10:00:00.000Z',
    messageCount: 3,
    parentId: 'parent',
    ...extra,
  }) as ChatSummary;

const render = (summary: ChatSummary): string =>
  renderToStaticMarkup(
    <ChatRow chat={summary} isActive={false} language="ru" onSelect={() => {}} depth={1} />,
  );

describe('строка списка чатов — метки дерева', () => {
  it('ждущий человека и принятый — со словами сводки хаба', () => {
    expect(render(chat({ awaitsYou: true }))).toContain(i18n.t('chat.cascade.tree.awaitsYou'));
    expect(render(chat({ accepted: true }))).toContain(i18n.t('chat.cascade.tree.accepted'));
  });

  it('без меток — ни одного из слов', () => {
    const html = render(chat());

    expect(html).not.toContain(i18n.t('chat.cascade.tree.awaitsYou'));
    expect(html).not.toContain(i18n.t('chat.cascade.tree.accepted'));
  });
});
