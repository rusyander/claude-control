import type { ServerMessageCode, ServerMessageParams } from '@agentdeck/contracts/server-messages';
import { coded } from '../../lib/server-text.ts';

/**
 * Отказ маршрутов групп по областям и «Пути»: статус, вид отказа (`error`, по
 * нему решает клиент) и код текста — сам текст живёт в словарях панели и
 * телефона. Русской строки в сервере здесь нет намеренно: счёт литералов
 * (`server-ru-literals.pins.json`) растёт только там, где без неё не обойтись.
 */
export class GroupRequestError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(
    statusCode: number,
    code: string,
    messageCode: ServerMessageCode,
    params?: ServerMessageParams,
  ) {
    super(code);
    this.name = 'GroupRequestError';
    this.statusCode = statusCode;
    this.code = code;
    coded(this, messageCode, params);
  }
}

export const groupNotFound = (): GroupRequestError =>
  new GroupRequestError(404, 'group_not_found', 'group-not-found');

export const badGroupRequest = (detail: string): GroupRequestError =>
  new GroupRequestError(400, 'invalid_request', 'group-request-invalid', { detail });

/** Ответ маршрута по отказу: `{error, messageCode, params?}`. */
export function refusalBody(error: GroupRequestError): Record<string, unknown> {
  const { messageCode, params } = error as unknown as {
    messageCode: string;
    params?: ServerMessageParams;
  };
  return { error: error.code, messageCode, ...(params ? { params } : {}) };
}
