import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PanelAgentMessage, PanelAgentPageContext } from '@agentdeck/contracts/panel-agent';
import {
  closePanelAgentTurn,
  isStalePanelAgentHistory,
  readPanelAgentConversation,
  recordPanelAgentTurnProgress,
  writePanelAgentConversation,
} from './conversations.ts';
import { maskPanelAgentMessages } from './data-mask.ts';
import { builtinRuleSet } from '../dlp/default-rules.ts';

/**
 * Ревью 26.09 (probe-z5/two-sealed): окно выбрасывает каждый оборванный ход —
 * просьбу вместе с запечатанным ответом. Возвращалась на место только ПОСЛЕДНЯЯ
 * такая пара, и после второго обрыва в той же вкладке следующий ход получал
 * ложный `conversation_stale` — «продолжили в другой вкладке», которой не было.
 */
const ID = '11111111-1111-4111-8111-111111111111';
const CONTEXT = { route: '/' } as PanelAgentPageContext;
const user = (content: string): PanelAgentMessage => ({ role: 'user', content });
const assistant = (content: string): PanelAgentMessage => ({ role: 'assistant', content });

describe('оборванные ходы одной вкладки', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-sealed-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** Ход окна: запись истории, затем ответ или обрыв после сказанного. */
  const turn = (window: PanelAgentMessage[], answer?: string): boolean => {
    if (isStalePanelAgentHistory(dir, ID, window)) return true;
    const written = writePanelAgentConversation(dir, ID, CONTEXT, window).messages;
    if (answer) {
      writePanelAgentConversation(dir, ID, CONTEXT, [...written, assistant(answer)]);
    } else {
      recordPanelAgentTurnProgress(dir, ID, { texts: ['начал'], actions: ['list_rules'] });
      closePanelAgentTurn(dir, ID, 'stopped');
    }
    return false;
  };

  it('два обрыва подряд — следующий ход не «устарел», все запечатанные пары на месте', () => {
    expect(turn([user('u1')])).toBe(false);
    expect(turn([user('u2')], 'a2')).toBe(false);
    const window = [user('u2'), assistant('a2')];
    expect(turn([...window, user('u3')])).toBe(false);
    expect(turn([...window, user('u4')], 'a4')).toBe(false);

    const saved = readPanelAgentConversation(dir, ID)!.messages;
    expect(saved.map((message) => message.content.slice(0, 2))).toEqual([
      'u1',
      saved[1]!.content.slice(0, 2),
      'u2',
      'a2',
      'u3',
      saved[5]!.content.slice(0, 2),
      'u4',
      'a4',
    ]);
    expect(saved.filter((message) => message.interrupted)).toHaveLength(2);
  });

  // Хвост просьб без ответа (ход упал раньше первого слова) окно выбрасывает
  // законно: запечатанная пара перед ним всё равно возвращается на место.
  it('обрыв, затем ход без единого слова — следующий ход не «устарел»', () => {
    expect(turn([user('u1')])).toBe(false);
    writePanelAgentConversation(dir, ID, CONTEXT, [user('u2')]);
    expect(isStalePanelAgentHistory(dir, ID, [user('u3')])).toBe(false);
  });

  /**
   * Ревью 28.09 (F-121): маршрут маскирует присланную историю ТЕКУЩИМИ правилами,
   * а в файле реплики лежат с масками своего хода. Сменились правила — склейка по
   * точному тексту расходилась, запечатанная пара не вставала на место, и вкладка
   * получала ложное «продолжили в другой вкладке».
   */
  describe('правила маски сменились между ходами (F-121)', () => {
    const rulesFile = (terms: string[]): void => {
      const rules = terms.length
        ? [{ ...builtinRuleSet()[0]!, id: 'own', name: 'Своё', kind: 'terms', terms }]
        : [];
      writeFileSync(join(dir, 'dlp-rules.json'), JSON.stringify({ version: 1, rules }));
    };
    /** Как маршрут: маска всей присланной истории правилами этой минуты. */
    const masked = (window: PanelAgentMessage[]): PanelAgentMessage[] => {
      const result = maskPanelAgentMessages(dir, window);
      if (!result.ok) throw new Error(result.message);
      return result.messages;
    };
    const u1 = user('Сделай отчёт для Иванов и Петров');
    const a1 = assistant('Готово');

    /** Ход с ответом, затем оборванный — с правилами этой минуты. */
    const answeredThenInterrupted = (): void => {
      expect(turn(masked([u1]), 'Готово')).toBe(false);
      expect(turn(masked([u1, a1, user('Теперь второй')]))).toBe(false);
    };
    /** Следующий ход той же вкладки: оборванную пару она выбросила. */
    const next = (): PanelAgentMessage[] => masked([u1, a1, user('Ещё раз')]);

    it('правило добавлено — ход не «устарел», пара на месте, история с новыми масками', () => {
      rulesFile(['Петров']);
      answeredThenInterrupted();
      rulesFile(['Петров', 'Иванов']);
      const window = next();
      expect(window[0]!.content).not.toContain('Иванов');
      expect(isStalePanelAgentHistory(dir, ID, window)).toBe(false);
      const saved = writePanelAgentConversation(dir, ID, CONTEXT, window).messages;
      expect(saved.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
      ]);
      expect(saved[3]!.interrupted).toBeTruthy();
      expect(saved[0]!.content).not.toContain('Иванов');
    });

    it('правило снято — ход не «устарел»', () => {
      rulesFile(['Иванов']);
      answeredThenInterrupted();
      rulesFile([]);
      const window = next();
      expect(readPanelAgentConversation(dir, ID)!.messages[0]!.content).not.toContain('Иванов');
      expect(window[0]!.content).toContain('Иванов');
      expect(isStalePanelAgentHistory(dir, ID, window)).toBe(false);
    });

    it('одно правило снято, другое добавлено в той же реплике — ход не «устарел»', () => {
      rulesFile(['Иванов']);
      answeredThenInterrupted();
      rulesFile(['Петров']);
      expect(isStalePanelAgentHistory(dir, ID, next())).toBe(false);
    });

    // Поправка на маску — только репликам человека: ответ агента маска не трогает,
    // и чужой ответ, отличный лишь словом, которое закрыло бы правило, — чужая история.
    it('ответ агента сверяется точно: отличный лишь словом под маской — отказ', () => {
      rulesFile(['Иванов']);
      const answer = 'Отчёт для Иванов готов';
      expect(turn(masked([u1]), answer)).toBe(false);
      expect(turn(masked([u1, assistant(answer), user('Теперь второй')]))).toBe(false);
      const foreign = masked([u1, assistant('Отчёт для Сидоров готов'), user('Ещё раз')]);
      expect(isStalePanelAgentHistory(dir, ID, foreign)).toBe(true);
      // Тот же ответ — своя вкладка, пара встаёт на место.
      const own = masked([u1, assistant(answer), user('Ещё раз')]);
      expect(isStalePanelAgentHistory(dir, ID, own)).toBe(false);
    });

    it('чужая реплика с другими масками — по-прежнему отказ', () => {
      rulesFile(['Иванов']);
      expect(turn(masked([u1]), 'Готово')).toBe(false);
      expect(turn(masked([u1, a1, user('из вкладки Б')]), 'б')).toBe(false);
      rulesFile(['Петров']);
      expect(isStalePanelAgentHistory(dir, ID, masked([u1, a1, user('из вкладки А')]))).toBe(true);
    });
  });

  it('настоящая вторая вкладка по-прежнему получает отказ', () => {
    expect(turn([user('u1')], 'a1')).toBe(false);
    expect(turn([user('u1'), assistant('a1'), user('из вкладки Б')], 'б')).toBe(false);
    expect(turn([user('u1'), assistant('a1'), user('из вкладки А')])).toBe(true);
  });
});
