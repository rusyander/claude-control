import { describe, expect, it } from 'vitest';
import { buildHandoffPrompt } from '@agentdeck/contracts/chat-handoff';
import { ANSWER_LANGUAGE_LINE } from '@agentdeck/contracts/model-cascade';
import {
  OWNER_PRECEDENCE_LINE,
  OWNER_PRECEDENCE_PLAIN_LINE,
} from '@agentdeck/contracts/quality-floor';
import { withoutPanelPreamble } from './panel-preamble.ts';

/**
 * Хвост панели в названии чата: строка старшинства бывает двух видов — с
 * исключением о расписании доставки и простая (одиночный чат и стадии без
 * доставки, F-57/F-124). Обе — текст панели, а не слова человека.
 */
describe('withoutPanelPreamble: хвост панели', () => {
  const proposal = {
    done: 'Готово',
    next: 'Добавь проверку входа',
    checkpoint: '.agent/PROGRESS.md',
  } as Parameters<typeof buildHandoffPrompt>[0];

  it('продолжение одиночного чата — без простой строки старшинства и строки языка', () => {
    const prompt = buildHandoffPrompt(proposal);
    expect(prompt).toContain(OWNER_PRECEDENCE_PLAIN_LINE);
    const title = withoutPanelPreamble(prompt);
    expect(title).not.toContain(OWNER_PRECEDENCE_PLAIN_LINE);
    expect(title).not.toContain(ANSWER_LANGUAGE_LINE);
    expect(title.trim()).toBe('Добавь проверку входа');
  });

  it('строка старшинства с доставкой снимается по-прежнему', () => {
    const text = `Почини логин\n\n${ANSWER_LANGUAGE_LINE}\n${OWNER_PRECEDENCE_LINE}`;
    expect(withoutPanelPreamble(text).trim()).toBe('Почини логин');
  });

  it('простая строка старшинства отдельным абзацем — тоже хвост панели', () => {
    const text = `Почини логин\n\n${OWNER_PRECEDENCE_PLAIN_LINE}`;
    expect(withoutPanelPreamble(text).trim()).toBe('Почини логин');
  });

  // RF-BGCD-12c: задания, сохранённые до F-62b, несут прежние формы строки
  // («never push with a bare --force»); `withoutPrecedence` их снимал, а название
  // чата — нет, и продолжение старого задания называлось английской строкой правил.
  it('прежние формы строки старшинства — тоже хвост панели', () => {
    const legacy = (line: string) =>
      line.replace('never force-push any branch but your own', 'never push with a bare --force');
    for (const line of [OWNER_PRECEDENCE_LINE, OWNER_PRECEDENCE_PLAIN_LINE]) {
      expect(legacy(line)).not.toBe(line);
      const text = `Почини логин\n\n${ANSWER_LANGUAGE_LINE}\n${legacy(line)}`;
      expect(withoutPanelPreamble(text).trim()).toBe('Почини логин');
    }
  });
});
