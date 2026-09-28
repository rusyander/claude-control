import type { ChatMessage } from '@agentdeck/contracts';

/**
 * Реплика «человека», которую написал не человек. Итог фоновой задачи (команды
 * или субагента) CLI кладёт в транскрипт строкой `<task-notification>` от имени
 * пользователя. Телефон рисовал её пузырём человека — простынёй XML, будто её
 * отправил он сам (живой прогон 28.09, 1b). Разбор тот же, что у панели
 * (`features/ChatMessages/lib/taskNotice.ts`): признак — текст НАЧИНАЕТСЯ с
 * тега, человек, вставивший тег посреди сообщения, остаётся человеком.
 */
export interface TaskNotice {
  /** `completed`, `failed`, `killed` — как пишет CLI; неизвестное — как есть. */
  status: string;
  /** Английская строка CLI: «Agent "…" completed». */
  summary: string;
}

const NOTICE = /<task-notification>([\s\S]*?)<\/task-notification>/g;

function field(body: string, name: string): string {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() ?? '';
}

/** Уведомления из реплики — или `undefined`, если это настоящая реплика человека. */
export function taskNoticesOf(message: ChatMessage): TaskNotice[] | undefined {
  if (message.role !== 'user' || message.blocks.length !== 1) return undefined;
  const block = message.blocks[0];
  if (block?.type !== 'text' || !block.text.trimStart().startsWith('<task-notification>')) {
    return undefined;
  }
  return [...block.text.matchAll(NOTICE)].map(([, body = '']) => ({
    status: field(body, 'status'),
    summary: field(body, 'summary'),
  }));
}
