import type { ChatMessage } from '@agentdeck/contracts';

/**
 * Реплика «человека», которую написал не человек. Когда фоновая команда
 * заканчивается между ходами, CLI сам будит разговор и кладёт в транскрипт
 * уведомление `<task-notification>` от имени пользователя. Пузырём реплики оно
 * читалось как простыня XML, будто её отправил человек, — и закрывало открытый
 * вопрос агента, хотя человек на него не отвечал.
 */
export interface TaskNotice {
  /** `completed`, `failed`, `killed` — как пишет CLI; неизвестное — как есть. */
  status: string;
  /** Английская строка CLI: «Background command "…" completed (exit code 0)». */
  summary: string;
}

const NOTICE = /<task-notification>([\s\S]*?)<\/task-notification>/g;

function field(body: string, name: string): string {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() ?? '';
}

/**
 * Уведомления из реплики — или `undefined`, если это настоящая реплика человека.
 * Признак — текст НАЧИНАЕТСЯ с тега: человек, вставивший такой тег посреди
 * своего сообщения, остаётся человеком. Хвост после тегов (подсказка CLI, где
 * лежит вывод) не показываем — он для модели.
 */
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
