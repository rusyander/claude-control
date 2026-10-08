import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';

/**
 * Код для сообщения проверки zod, которое уходит человеку.
 *
 * Схемы живут в контрактах и пишут причину по-русски (их читают и сервер, и
 * клиенты), а код в схему не положить: zod несёт только текст. Поэтому код
 * находится здесь по тексту. Таблица узкая — только сообщения, которые маршрут
 * отдаёт на экран; текст сменили в контракте — тест `zod-issue-codes.test.ts`
 * краснеет, а не перевод молча пропадает.
 */
const ISSUE_CODES: Readonly<Record<string, ServerMessageCode>> = {
  'опишите картинку': 'media-prompt-empty',
  'описание длиннее 4000 знаков': 'media-prompt-too-long',
  'назовите тему презентации': 'media-deck-topic-empty',
  'тема длиннее 4000 знаков': 'media-deck-topic-too-long',
  'блок пустой': 'media-block-empty',
  'последняя реплика должна быть человека': 'panel-agent-last-not-user',
};

export function issueCode(message: string | undefined): ServerMessageCode | undefined {
  return message === undefined ? undefined : ISSUE_CODES[message];
}

/**
 * Тело отказа по первой проблеме проверки: её текст с кодом, если он известен.
 * Нет проблемы — запасная фраза маршрута со своим кодом. Незнакомая проблема
 * (стандартный английский текст zod) уходит без кода — клиент покажет её как есть.
 */
export function issueBody(
  issues: readonly { message: string }[],
  fallback: string,
  fallbackCode?: ServerMessageCode,
): { message: string; messageCode?: ServerMessageCode } {
  const first = issues[0]?.message;
  if (first === undefined) {
    return fallbackCode ? { message: fallback, messageCode: fallbackCode } : { message: fallback };
  }
  const messageCode = issueCode(first);
  return messageCode ? { message: first, messageCode } : { message: first };
}

/** Код, только когда проблема одна: склеенный список нескольких проблем одной фразой не переводится. */
export function singleIssueCode(
  issues: readonly { message: string }[],
): ServerMessageCode | undefined {
  return issues.length === 1 ? issueCode(issues[0]?.message) : undefined;
}
