import type { ProviderChatMessage } from '@agentdeck/contracts';

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
 * не влезет, — с меткой для модели, сколько их было. Указание панели (реплики
 * `system-prefix`: планка сдачи, эскалация, навыки, хуки) не отбрасывается
 * никогда, и последний вопрос тоже. Не влезают они — промпта нет, есть размер:
 * запуск отказывает вслух, а не режет задание (TQ-05, F1, 12.10.2026: задание
 * группы уходило обрезанным без метки, а указание панели терялось первым).
 */

/** Сколько символов промпта считаем безопасными для argv на всех системах. */
export const MAX_PROMPT_CHARS = 24_000;

function label(message: ProviderChatMessage): string {
  return message.role === 'assistant' ? `Assistant: ${message.content}` : message.content;
}

/** Синтетическая реплика панели — указание, блок навыка или хука. */
const PINNED_ID = 'system-prefix';

const droppedLine = (count: number): string =>
  `[${count} earlier messages of this conversation left out by the panel — over the command-line limit]`;

export interface BuiltPrompt {
  text: string;
  /** Сколько ранних реплик не поместилось — модель видит это меткой в промпте. */
  droppedMessages: number;
  /**
   * Указание панели с последним вопросом длиннее предела: `text` пуст, здесь —
   * сколько знаков заняли бы они одни. Обрубком такой промпт не уходит.
   */
  overflow?: number;
}

export function buildPrompt(
  history: ProviderChatMessage[],
  maxChars: number = MAX_PROMPT_CHARS,
): BuiltPrompt {
  // Неудавшиеся ответы в контекст не идут: там текст ошибки CLI, а не слова
  // модели — модель приняла бы их за свою реплику. Заметки панели — тем более:
  // это её слова человеку о том, чего не получилось, а не часть разговора.
  const usable = history.filter((message) => !message.failed && message.role !== 'notice');
  if (usable.length === 0) return { text: '', droppedMessages: 0 };

  const pinned = usable.filter((message) => message.id === PINNED_ID).map(label);
  const talk = usable.filter((message) => message.id !== PINNED_ID);
  const compose = (start: number): string =>
    [...pinned, ...(start > 0 ? [droppedLine(start)] : []), ...talk.slice(start).map(label)]
      .join('\n\n')
      .trim();

  let start = 0;
  let text = compose(start);
  while (text.length > maxChars && start < talk.length - 1) {
    start += 1;
    text = compose(start);
  }
  if (text.length > maxChars) return { text: '', droppedMessages: start, overflow: text.length };

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

  return [text.trim(), '', 'Files:', ...paths.map((path) => path)].join('\n').trim();
}
