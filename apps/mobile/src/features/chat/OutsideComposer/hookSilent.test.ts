import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@agentdeck/contracts';
import { stepFinishedSince } from './hookSilent';

const at = (second: number): string => new Date(Date.UTC(2026, 9, 11, 20, 0, second)).toISOString();
const reply = (second: number, tool: boolean): ChatMessage => ({
  id: `a${second}`,
  role: 'assistant',
  timestamp: at(second),
  blocks: tool
    ? [{ type: 'tool', name: 'Bash', input: 'ping -n 120 127.0.0.1' }]
    : [{ type: 'text', text: 'Готово' }],
});
const prompt: ChatMessage = {
  id: 'u0',
  role: 'user',
  timestamp: at(0),
  blocks: [{ type: 'text', text: 'Шаг 1' }],
};

/**
 * Живая проверка 11.10: свежая сессия с хуками, первый инструмент идёт две
 * минуты, телефон уже пишет «хуки не отзывались… только после перезапуска» —
 * хотя хук просто ещё не мог сработать.
 */
describe('stepFinishedSince', () => {
  it('первый инструмент ещё идёт — шага не было, предупреждать не о чем', () => {
    expect(stepFinishedSince([prompt, reply(2, true)], at(5))).toBe(false);
  });

  it('за вызовом инструмента пришёл новый ответ после постановки — шаг был', () => {
    expect(stepFinishedSince([prompt, reply(2, true), reply(130, true)], at(5))).toBe(true);
  });

  it('шаг закончился до постановки сообщения — не в счёт', () => {
    expect(stepFinishedSince([prompt, reply(2, true), reply(4, true)], at(5))).toBe(false);
  });

  it('ответ без инструментов перед ним шагом не считается', () => {
    expect(stepFinishedSince([prompt, reply(6, false), reply(8, false)], at(5))).toBe(false);
  });
});
