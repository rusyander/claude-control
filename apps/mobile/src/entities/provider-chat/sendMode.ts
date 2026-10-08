import type { ProviderChatStatus } from '@agentdeck/contracts';

/**
 * Что сделает отправка сейчас: обычный вопрос, слово в идущий ход (CLI примет
 * его посреди ответа) или очередь до конца ответа. Сервер решает сам по
 * `queueIfBusy`; здесь — только честная подпись кнопки.
 */
export type SendMode = 'send' | 'steer' | 'queue';

export function sendMode(status: ProviderChatStatus | undefined): SendMode {
  if (!status?.isRunning) return 'send';
  return status.steerable ? 'steer' : 'queue';
}
