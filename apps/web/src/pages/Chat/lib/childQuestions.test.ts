import { describe, it, expect } from 'vitest';
import type { ChatSummary } from '@claude-control/contracts';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import { collectChildQuestions } from './childQuestions';

/**
 * Вопросы детей в родительском разговоре. Проверяется то, ради чего это и
 * заведено: человек отвечает шести агентам из одного места, не обходя их чаты.
 *
 * Отдельно — совпадение по `sessionId`: чат, заведённый разделением, живёт под
 * временным `new-…`, пока Claude Code не выдаст настоящий идентификатор, и
 * поиск только по `id` терял бы половину детей молча.
 */

function chat(id: string, extra: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    title: `чат ${id}`,
    projectPath: 'C:/work/repo',
    updatedAt: '2026-09-02T00:00:00.000Z',
    messages: 0,
    isSandbox: false,
    ...extra,
  } as ChatSummary;
}

function run(id: string, extra: Partial<ActiveRunView> = {}): ActiveRunView {
  return { id, status: 'waiting', ...extra };
}

const ask = (question: string, id = 'tu-1') => ({
  name: 'AskUserQuestion',
  id,
  input: JSON.stringify({ questions: [{ question, options: [{ label: 'да' }] }] }),
});

describe('collectChildQuestions', () => {
  it('вопрос ребёнка виден в родителе — с подписью, чей он', () => {
    const chats = [chat('parent'), chat('kid', { parentId: 'parent', title: 'Группа A' })];
    const runs = [run('kid', { tools: [ask('Формат даты?')] })];

    expect(collectChildQuestions(chats, 'parent', runs)).toEqual([
      {
        chatId: 'kid',
        title: 'Группа A',
        input: ask('Формат даты?').input,
        toolUseId: 'tu-1',
        isRunning: false,
      },
    ]);
  });

  /**
   * Занятость ребёнка едет вместе с вопросом: от неё зависит не доступность
   * выбора, а подпись под ним — ответ работающему агенту ждёт конца хода в его
   * очереди, и обещать «агент думает» в этот момент значит соврать.
   */
  it('занятость ребёнка едет вместе с вопросом', () => {
    const chats = [chat('parent'), chat('kid', { parentId: 'parent' })];
    const busy = collectChildQuestions(chats, 'parent', [
      run('kid', { status: 'running', tools: [ask('Формат даты?')] }),
    ]);

    expect(busy[0]?.isRunning).toBe(true);
  });

  it('ребёнок под временным ключом находится по sessionId', () => {
    const chats = [chat('parent'), chat('real-session', { parentId: 'parent', title: 'Группа B' })];
    const runs = [run('new-1712', { sessionId: 'real-session', tools: [ask('Куда класть?')] })];

    const found = collectChildQuestions(chats, 'parent', runs);
    expect(found).toHaveLength(1);
    // Ответ уходит по ключу ПРОГОНА, а не по id чата: под ним прогон и живёт.
    expect(found[0]?.chatId).toBe('new-1712');
  });

  /**
   * За длинный ход агент спрашивает не по одному разу. Показывать все — значит
   * вывалить в родителя стопку отвеченных карточек; человеку нужен последний.
   */
  it('от одного ребёнка берётся последний вопрос', () => {
    const chats = [chat('parent'), chat('kid', { parentId: 'parent' })];
    const runs = [
      run('kid', {
        tools: [ask('Первый', 'tu-1'), { name: 'Read', input: '{}' }, ask('Второй', 'tu-2')],
      }),
    ];

    const found = collectChildQuestions(chats, 'parent', runs);
    expect(found).toHaveLength(1);
    expect(found[0]?.toolUseId).toBe('tu-2');
  });

  it('чужие дети и обычные вызовы сюда не попадают', () => {
    const chats = [
      chat('parent'),
      chat('kid', { parentId: 'parent' }),
      chat('stranger', { parentId: 'other-parent' }),
    ];
    const runs = [
      run('kid', { tools: [{ name: 'Bash', input: '{"command":"ls"}' }] }),
      run('stranger', { tools: [ask('Чужой вопрос')] }),
      // Свой собственный вопрос родителя тоже не дублируем — он и так в ленте.
      run('parent', { tools: [ask('Свой вопрос')] }),
    ];

    expect(collectChildQuestions(chats, 'parent', runs)).toEqual([]);
  });

  it('без открытого разговора и без детей — пусто', () => {
    const chats = [chat('parent'), chat('kid', { parentId: 'parent' })];
    expect(collectChildQuestions(chats, undefined, [run('kid', { tools: [ask('Что?')] })])).toEqual(
      [],
    );
    expect(collectChildQuestions([chat('lonely')], 'lonely', [])).toEqual([]);
  });
});
