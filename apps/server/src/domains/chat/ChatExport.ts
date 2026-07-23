import type { ChatMessage, ChatExportEntry } from '@claude-control/contracts';

/**
 * Выгрузка разговора файлом. В экспорт идёт только суть переписки — роль, время
 * и текст реплики. Размышления, вызовы инструментов и вложения-картинки
 * намеренно опускаем: в них нет ценности для читателя выгрузки, а вот
 * служебное и возможные секреты (пути, команды, base64) выносить наружу незачем.
 */

export type ExportFormat = 'md' | 'json';

export interface ExportFile {
  content: string;
  mime: string;
  ext: string;
}

/** Плоское представление реплики: склеенный текст без служебных блоков. */
function toEntries(messages: ChatMessage[]): ChatExportEntry[] {
  const entries: ChatExportEntry[] = [];

  for (const message of messages) {
    const text = message.blocks
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n\n')
      .trim();

    // Реплики без текста (только инструмент/размышление/картинка) в выгрузку
    // не попадают — показывать в ней нечего.
    if (!text) continue;

    entries.push({ role: message.role, timestamp: message.timestamp, text });
  }

  return entries;
}

/** Человекочитаемое имя роли для разметки. */
function roleLabel(role: ChatExportEntry['role']): string {
  return role === 'user' ? 'Пользователь' : 'Claude';
}

/** Время в компактном виде; пустое/битое — опускаем. */
function formatTime(timestamp: string): string {
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? '' : new Date(time).toISOString().replace('T', ' ').slice(0, 19);
}

/** Разговор как Markdown: заголовок роли со временем и текст реплики под ним. */
export function exportChatMarkdown(messages: ChatMessage[], title?: string): string {
  const entries = toEntries(messages);
  const head = `# ${title?.trim() || 'Разговор Claude Code'}\n`;

  const body = entries
    .map((entry) => {
      const time = formatTime(entry.timestamp);
      const heading = time
        ? `## ${roleLabel(entry.role)} · ${time}`
        : `## ${roleLabel(entry.role)}`;
      return `${heading}\n\n${entry.text}`;
    })
    .join('\n\n');

  return `${head}\n${body}\n`;
}

/** Разговор как JSON: массив реплик `{ role, timestamp, text }`. */
export function exportChatJson(messages: ChatMessage[]): string {
  return JSON.stringify(toEntries(messages), null, 2);
}

/** Собрать выгрузку в выбранном формате вместе с mime-типом и расширением. */
export function buildChatExport(
  messages: ChatMessage[],
  format: ExportFormat,
  title?: string,
): ExportFile {
  if (format === 'json') {
    return {
      content: exportChatJson(messages),
      mime: 'application/json; charset=utf-8',
      ext: 'json',
    };
  }
  return {
    content: exportChatMarkdown(messages, title),
    mime: 'text/markdown; charset=utf-8',
    ext: 'md',
  };
}
