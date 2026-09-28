import { describe, it, expect } from 'vitest';
import type { EscalationNotice } from '@agentdeck/contracts/chat-group-settings';
import type { ChatEvent } from './chat-events.ts';
import { createEscalations } from './escalations.ts';

/**
 * Заметки главному чату дерева. Правдивость сигнала держат четыре вещи: заметка
 * ложится в КОРЕНЬ (не в прямого родителя), у самого корня её нет, повтор того
 * же блока не дублирует карточку, некритический выбор остаётся в ребёнке.
 */
function harness(parents: Record<string, string>, titles: Record<string, string> = {}) {
  const stored: { root: string; notice: EscalationNotice }[] = [];
  const said: { root: string; event: ChatEvent }[] = [];
  let changed = 0;
  const rootOf = (keys: readonly string[]): string => {
    let current = keys.at(-1) ?? '';
    for (let depth = 0; parents[current] && depth < 10; depth += 1) current = parents[current]!;
    return current;
  };
  const escalations = createEscalations({
    canonical: (key) => (key === 'new-kid' ? 'kid' : key),
    parentOf: (key) => parents[key],
    titleOf: (key) => titles[key],
    rootOf,
    store: (root, notice) => {
      if (stored.some((item) => item.root === root && item.notice.text === notice.text)) {
        return false;
      }
      stored.push({ root, notice });
      return true;
    },
    say: (root, event) => {
      said.push({ root, event });
      return true;
    },
    changed: () => {
      changed += 1;
    },
    now: () => '2026-09-26T10:00:00.000Z',
  });
  return { escalations, stored, said, changed: () => changed };
}

const block = (text: string): string =>
  ['Готово.', '```agentdeck:escalate', JSON.stringify({ severity: 'critical', text }), '```'].join(
    '\n',
  );

describe('заметки главному чату', () => {
  it('блок ребёнка — в КОРЕНЬ дерева, с подписью группы и событием в ленту', () => {
    const h = harness({ grandkid: 'kid', kid: 'root' }, { grandkid: 'Правка API' });
    expect(h.escalations.fromReply(['grandkid'], block('миграция удалит данные'))).toBe(1);
    expect(h.stored).toEqual([
      {
        root: 'root',
        notice: {
          childChatId: 'grandkid',
          childTitle: 'Правка API',
          text: 'миграция удалит данные',
          source: 'block',
          at: '2026-09-26T10:00:00.000Z',
        },
      },
    ]);
    expect(h.said).toHaveLength(1);
    expect(h.said[0]?.root).toBe('root');
    expect(h.said[0]?.event.kind).toBe('escalation');
    expect(h.changed()).toBe(1);
  });

  it('у самого корня заметок нет — он и есть главный чат', () => {
    const h = harness({});
    expect(h.escalations.fromReply(['root'], block('что-то'))).toBe(0);
    expect(h.stored).toHaveLength(0);
    expect(h.changed()).toBe(0);
  });

  it('временный ключ, связанный с самим собой, — не ребёнок: заметки себе нет', () => {
    // Вкладка `new-kid` указывает на свой же разговор `kid`: без сверки корня с
    // ребёнком после приведения ключей главный чат получил бы карточку от себя.
    const h = harness({ 'new-kid': 'kid' });
    expect(h.escalations.fromReply(['new-kid'], block('что-то'))).toBe(0);
    expect(h.stored).toHaveLength(0);
  });

  it('тот же блок дважды — одна заметка и одно пробуждение', () => {
    const h = harness({ kid: 'root' });
    h.escalations.fromReply(['kid'], block('одно'));
    expect(h.escalations.fromReply(['kid'], block('одно'))).toBe(0);
    expect(h.stored).toHaveLength(1);
    expect(h.changed()).toBe(1);
  });

  it('ответ без блока и сломанный блок — ничего', () => {
    const h = harness({ kid: 'root' });
    expect(h.escalations.fromReply(['kid'], 'просто ответ')).toBe(0);
    expect(
      h.escalations.fromReply(
        ['kid'],
        '```agentdeck:escalate\n{"severity":"minor","text":"x"}\n```',
      ),
    ).toBe(0);
    expect(h.stored).toHaveLength(0);
  });

  it('ребёнок под временным ключом — заметка на его настоящий ключ, без подписи — ключ', () => {
    const h = harness({ 'new-kid': 'root' });
    h.escalations.fromReply(['new-kid'], block('x'));
    expect(h.stored[0]?.notice.childChatId).toBe('kid');
    expect(h.stored[0]?.notice.childTitle).toBe('kid');
  });

  it('автовыбор: в корень только критичные', () => {
    const h = harness({ kid: 'root' });
    const added = h.escalations.fromPicks(
      ['kid'],
      [
        { question: 'Удалить ветку?', label: 'Да (Recommended)', critical: true },
        { question: 'Стиль?', label: 'Короткий (Recommended)', critical: false },
      ],
    );
    expect(added).toBe(1);
    expect(h.stored[0]?.notice).toMatchObject({
      text: 'Удалить ветку? → Да (Recommended)',
      source: 'auto-pick',
    });
  });
});
