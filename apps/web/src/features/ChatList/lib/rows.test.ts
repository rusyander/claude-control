import { describe, it, expect } from 'vitest';
import type { ChatSummary } from '@claude-control/contracts';
import { withTree, withGroupHeaders } from './rows';
import type { ChatRowData } from '../ui/ChatList.types';

/**
 * Дерево в списке чатов. Нужно ровно для одного: увидеть, что несколько чатов
 * приехали из одной просьбы «раздели задачи», — иначе они лежат в списке
 * вперемешку с остальными и понять их родство неоткуда.
 */

const NOW = new Date().toISOString();

function chat(id: string, parentId?: string, updatedAt = NOW): ChatSummary {
  return {
    id,
    title: id,
    project: 'demo',
    projectPath: 'C:/work/demo',
    isSandbox: false,
    messageCount: 1,
    createdAt: updatedAt,
    updatedAt,
    ...(parentId ? { parentId } : {}),
  };
}

const row = (summary: ChatSummary): ChatRowData => ({ chat: summary });

describe('дерево чатов в списке', () => {
  it('ставит порождённые чаты под их родителя', () => {
    const rows = withTree([
      row(chat('дитя-2', 'родитель')),
      row(chat('дитя-1', 'родитель')),
      row(chat('родитель')),
      row(chat('посторонний')),
    ]);

    expect(rows.map((item) => item.chat.id)).toEqual([
      'родитель',
      'дитя-2',
      'дитя-1',
      'посторонний',
    ]);
    expect(rows.map((item) => item.depth)).toEqual([undefined, 1, 1, undefined]);
  });

  it('сироту не прячет: родителя нет в списке — строка остаётся своей', () => {
    const rows = withTree([row(chat('дитя', 'которого-нет')), row(chat('обычный'))]);

    expect(rows.map((item) => item.chat.id)).toEqual(['дитя', 'обычный']);
    expect(rows[0]?.depth).toBeUndefined();
  });

  it('список без разделений не трогает вовсе', () => {
    const items = [row(chat('раз')), row(chat('два'))];

    expect(withTree(items)).toBe(items);
  });

  it('ветвь не отрывается от корня заголовком даты', () => {
    // У ребёнка своя дата: без поправки между ним и родителем встал бы
    // заголовок «Ранее», и дерево распалось бы ровно там, ради чего рисуется.
    const old = '2020-01-01T00:00:00.000Z';
    const rows = withGroupHeaders(
      withTree([row(chat('дитя', 'родитель', old)), row(chat('родитель'))]),
    );

    expect(
      rows.map((item) => (item.kind === 'header' ? `#${item.group}` : item.data.chat.id)),
    ).toEqual(['#today', 'родитель', 'дитя']);
  });
});
