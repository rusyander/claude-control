import { describe, it, expect } from 'vitest';
import type { ProviderChatMessage } from '@claude-control/contracts';
import { MAX_PROMPT_CHARS, buildPrompt, composeUserMessage } from './prompt.ts';

function message(
  role: ProviderChatMessage['role'],
  content: string,
  failed = false,
): ProviderChatMessage {
  return {
    id: `${role}-${content.slice(0, 4)}`,
    role,
    content,
    at: '2026-01-01T00:00:00.000Z',
    failed,
  };
}

/**
 * Сборка промпта. Проверяем ровно то, ради чего она есть: контекст доезжает, а
 * длинный разговор урезается спереди, а не обрубается командной строкой сзади.
 */
describe('buildPrompt', () => {
  it('склеивает переписку, помечая только реплики модели', () => {
    const { text, droppedMessages } = buildPrompt([
      message('user', 'Вопрос'),
      message('assistant', 'Ответ'),
      message('user', 'Ещё'),
    ]);

    expect(text).toBe('Вопрос\n\nAssistant: Ответ\n\nЕщё');
    expect(droppedMessages).toBe(0);
  });

  it('выбрасывает неудавшиеся ответы: там текст ошибки, а не слова модели', () => {
    const { text } = buildPrompt([
      message('user', 'Вопрос'),
      message('assistant', 'CLI не найден', true),
      message('user', 'Ещё'),
    ]);

    expect(text).toBe('Вопрос\n\nЕщё');
  });

  it('отбрасывает старые реплики, пока промпт не влезет', () => {
    const { text, droppedMessages } = buildPrompt(
      [
        message('user', 'а'.repeat(50)),
        message('user', 'б'.repeat(50)),
        message('user', 'в'.repeat(10)),
      ],
      60,
    );

    expect(droppedMessages).toBe(2);
    expect(text).toBe('в'.repeat(10));
  });

  it('никогда не выбрасывает последний вопрос — режет его сам', () => {
    const { text, droppedMessages } = buildPrompt([message('user', 'я'.repeat(100))], 40);

    expect(droppedMessages).toBe(0);
    expect(text).toHaveLength(40);
  });

  it('пустая переписка даёт пустой промпт', () => {
    expect(buildPrompt([])).toEqual({ text: '', droppedMessages: 0 });
  });

  it('по умолчанию держится в пределах, безопасных для argv', () => {
    const { text } = buildPrompt([message('user', 'я'.repeat(MAX_PROMPT_CHARS * 2))]);

    expect(text.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });
});

describe('composeUserMessage', () => {
  it('без вложений отдаёт сам текст', () => {
    expect(composeUserMessage('  Вопрос  ')).toBe('Вопрос');
  });

  it('дописывает пути файлов отдельным блоком', () => {
    expect(composeUserMessage('Посмотри', ['/a/b.ts', ' /c/d.ts '])).toBe(
      'Посмотри\n\nФайлы:\n/a/b.ts\n/c/d.ts',
    );
  });

  it('пустые пути отбрасывает', () => {
    expect(composeUserMessage('Вопрос', ['  ', ''])).toBe('Вопрос');
  });
});
