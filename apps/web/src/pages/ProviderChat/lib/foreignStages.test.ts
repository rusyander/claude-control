import { describe, it, expect } from 'vitest';
import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import { collectForeignStages } from './foreignStages';

const node = (over: Partial<ChatTreeView['nodes'][number]>): ChatTreeView['nodes'][number] => ({
  chatId: 'codex:c1',
  aliases: [],
  parentChatId: 'codex:parent',
  running: false,
  ...over,
});

const tree = (over: Partial<ChatTreeView>): ChatTreeView => ({
  root: 'codex:parent',
  running: 0,
  nodes: [],
  ...over,
});

describe('collectForeignStages', () => {
  it('дерева нет — строк нет, а не пустая карточка', () => {
    expect(collectForeignStages(undefined)).toEqual([]);
  });

  it('звенья одной ветки — одна строка группы, звенья по порядку', () => {
    const rows = collectForeignStages(
      tree({
        nodes: [
          node({ chatId: 'codex:c1', title: 'Механика', branch: 'split/mech', stage: 'work' }),
          node({
            chatId: 'codex:c2',
            title: 'Механика',
            branch: 'split/mech',
            stage: 'review',
            running: true,
          }),
        ],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.stages).toEqual(['work', 'review']);
    expect(rows[0]?.branch).toBe('split/mech');
    expect(rows[0]?.isRunning).toBe(true);
  });

  it('строка открывает разговор его СОБСТВЕННЫМ ключом, без приставки провайдера', () => {
    const rows = collectForeignStages(
      tree({ nodes: [node({ chatId: 'codex:c9', title: 'Архитектура' })] }),
    );

    expect(rows[0]?.chatId).toBe('c9');
  });

  it('разные ветки — разные группы', () => {
    const rows = collectForeignStages(
      tree({
        nodes: [
          node({ chatId: 'codex:c1', title: 'Механика', branch: 'split/mech' }),
          node({ chatId: 'codex:c2', title: 'Вёрстка', branch: 'split/ui' }),
        ],
      }),
    );

    expect(rows.map((row) => row.title)).toEqual(['Механика', 'Вёрстка']);
  });

  it('дерево на паузе — строки помечены остановленными', () => {
    const rows = collectForeignStages(
      tree({
        paused: { at: '2026-09-09T10:00:00.000Z', chats: 1, pending: 0 },
        nodes: [node({ title: 'Механика' })],
      }),
    );

    expect(rows[0]?.isPaused).toBe(true);
  });

  it('незнакомое звено читается как работа, а не теряет строку', () => {
    const rows = collectForeignStages(
      tree({ nodes: [node({ title: 'Механика', stage: 'выдумка' })] }),
    );

    expect(rows[0]?.stages).toEqual(['work']);
  });
});
