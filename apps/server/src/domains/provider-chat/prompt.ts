import type { ProviderChatMessage } from '@claude-control/contracts';

/**
 * Сборка промпта для чужого CLI: вся переписка одним текстом.
 *
 * Памяти между запусками у одноразового CLI нет по построению, поэтому контекст
 * восстанавливает панель — из своей же переписки. Это не догадка о чужом
 * формате: наружу уходит обычный текст, который CLI и так принимает.
 *
 * Ограничение здесь не выдумано ради красоты. Промпт уезжает ОТДЕЛЬНЫМ
 * элементом argv, а командная строка Windows обрывается примерно на 32 тысячах
 * символов — длинный разговор ушёл бы обрубком, и CLI ответил бы на половину
 * вопроса, не сказав об этом. Поэтому старые реплики отбрасываются, пока промпт
 * не влезет, а последний вопрос пользователя не отбрасывается никогда: без него
 * запускать нечего.
 */

/** Сколько символов промпта считаем безопасными для argv на всех системах. */
export const MAX_PROMPT_CHARS = 24_000;

function label(message: ProviderChatMessage): string {
  return message.role === 'assistant' ? `Assistant: ${message.content}` : message.content;
}

export interface BuiltPrompt {
  text: string;
  /** Сколько ранних реплик не поместилось — панель показывает это честно. */
  droppedMessages: number;
}

export function buildPrompt(
  history: ProviderChatMessage[],
  maxChars: number = MAX_PROMPT_CHARS,
): BuiltPrompt {
  // Неудавшиеся ответы в контекст не идут: там текст ошибки CLI, а не слова
  // модели — модель приняла бы их за свою реплику.
  const usable = history.filter((message) => !message.failed);
  if (usable.length === 0) return { text: '', droppedMessages: 0 };

  let start = 0;
  let text = usable.map(label).join('\n\n').trim();

  while (text.length > maxChars && start < usable.length - 1) {
    start += 1;
    text = usable.slice(start).map(label).join('\n\n').trim();
  }

  // Один-единственный вопрос длиннее предела — режем его сам текст: отказать
  // молча нельзя, а урезание видно в ответе модели.
  if (text.length > maxChars) text = text.slice(0, maxChars);

  return { text, droppedMessages: start };
}

/**
 * Текст реплики пользователя вместе с прикреплёнными файлами. Пути дописываются
 * строками: агентские CLI читают файлы сами, а вкладывать содержимое в промпт
 * значило бы придумывать за них формат вложения.
 */
export function composeUserMessage(text: string, attachments: string[] = []): string {
  const paths = attachments.map((path) => path.trim()).filter(Boolean);
  if (paths.length === 0) return text.trim();

  return [text.trim(), '', 'Файлы:', ...paths.map((path) => path)].join('\n').trim();
}
