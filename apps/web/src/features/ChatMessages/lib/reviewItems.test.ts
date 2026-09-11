import { describe, it, expect } from 'vitest';
import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import { collectReviews, reviewTreeOf } from './reviewItems';

/**
 * Карточки решения по ревью чужих MR (Т7): кому какие показывать.
 *
 * Проверяется то, чем этот сбор может навредить: показать человеку карточку
 * чужой группы (решение о работе, которую он не смотрел) или потерять свою —
 * тогда ревью просто зависает, и панель молчит.
 */

const REVIEW = { url: 'https://gitlab.com/team/app/-/merge_requests/42', findings: ['одно'] };

function tree(nodes: Partial<ChatTreeView['nodes'][number]>[]): ChatTreeView {
  return {
    root: 'parent',
    running: 0,
    nodes: nodes.map((node) => ({
      chatId: node.chatId ?? 'c1',
      aliases: node.aliases ?? [node.chatId ?? 'c1'],
      running: false,
      ...node,
    })),
  } as ChatTreeView;
}

describe('collectReviews', () => {
  it('родителю — все ревью дерева, с названием группы и ключом дерева', () => {
    const items = collectReviews({
      own: tree([
        { chatId: 'a', title: 'MR 42', parentChatId: 'parent', review: REVIEW },
        { chatId: 'b', title: 'Без ревью', parentChatId: 'parent' },
        { chatId: 'c', title: 'MR 43', parentChatId: 'parent', review: REVIEW },
      ]),
    });

    expect(items.map((item) => item.chatId)).toEqual(['a', 'c']);
    expect(items[0]).toMatchObject({ title: 'MR 42', parentChatId: 'parent' });
  });

  it('группа показывает ТОЛЬКО себя: соседей она не решает', () => {
    const items = collectReviews({
      parent: tree([
        { chatId: 'сосед', parentChatId: 'parent', review: REVIEW },
        { chatId: 'я', parentChatId: 'parent', review: REVIEW },
      ]),
      chatId: 'я',
    });

    expect(items.map((item) => item.chatId)).toEqual(['я']);
  });

  it('свой узел находится и по второму ключу разговора', () => {
    const items = collectReviews({
      parent: tree([{ chatId: 'new-1', aliases: ['new-1', 'session-1'], review: REVIEW }]),
      chatId: 'session-1',
    });

    expect(items).toHaveLength(1);
  });

  it('один и тот же узел в обоих деревьях не даёт двух карточек', () => {
    const node = { chatId: 'a', parentChatId: 'parent', review: REVIEW };
    const items = collectReviews({ own: tree([node]), parent: tree([node]), chatId: 'a' });

    expect(items).toHaveLength(1);
  });

  it('деревьев нет — карточек нет, и это обычный разговор', () => {
    expect(collectReviews({})).toEqual([]);
    expect(collectReviews({ parent: tree([{ chatId: 'чужой', review: REVIEW }]) })).toEqual([]);
  });
});

describe('reviewTreeOf', () => {
  const items = [{ chatId: 'a', parentChatId: 'дерево', review: { url: 'u', findings: [] } }];

  it('берёт дерево из самой карточки', () => {
    expect(reviewTreeOf(items, 'a', ['запасное'])).toBe('дерево');
  });

  it('карточки нет — идёт первый непустой запасной ключ', () => {
    expect(reviewTreeOf(items, 'нет', [undefined, 'запасное'])).toBe('запасное');
    expect(reviewTreeOf(items, 'нет', [undefined])).toBe('');
  });
});
