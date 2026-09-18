import type { ServerMessageCode, ServerMessageParams } from '@agentdeck/contracts/server-messages';
import { coded } from '../../lib/server-text.ts';

/**
 * Отказы внешних интеграций — состояние, а не падение.
 *
 * Правило партии: мёртвая интеграция никогда не роняет ни прогон тестов, ни
 * разговор, ни старт панели. Поэтому у каждой ошибки здесь есть и код, по
 * которому клиент отличает «не настроено» от «не отвечает», и русская строка,
 * которую человеку показывают как есть.
 *
 * `statusCode` + `code` — та же форма, что у ошибок MCP (`domains/mcp.ts`):
 * Fastify отдаёт её сам, даже если маршрут её не поймал.
 */

export type IntegrationErrorCode =
  'invalid_body' | 'integration_not_found' | 'integration_busy' | 'integration_unreachable';

const STATUS: Record<IntegrationErrorCode, number> = {
  invalid_body: 400,
  integration_not_found: 404,
  integration_busy: 409,
  integration_unreachable: 502,
};

export class IntegrationError extends Error {
  readonly statusCode: number;
  readonly code: IntegrationErrorCode;
  /** Подробность отказа: ответ системы, имя незаполненного поля, адрес. */
  readonly detail?: string;

  constructor(code: IntegrationErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
    this.statusCode = STATUS[code];
    this.detail = detail;
  }
}

/** Интеграция не настроена или выключена — 404, а не «сломалось». */
export function notConnected(what: string): IntegrationError {
  return new IntegrationError(
    'integration_not_found',
    `${what} не подключена: задайте адрес и токен в настройках панели.`,
  );
}

/**
 * Поле запроса не заполнено — 400 с ИМЕНЕМ поля, а не «неверный запрос».
 * `code` — код всей фразы «Запрос не принят: … (поле).» для перевода на клиенте;
 * `field` в подстановки кладёт сам вызывающий (так её видит сверка кодов).
 */
export function invalidField(
  field: string,
  why: string,
  code?: ServerMessageCode,
  params?: ServerMessageParams,
): IntegrationError {
  const error = new IntegrationError('invalid_body', `Запрос не принят: ${why} (${field}).`, field);
  return code ? coded(error, code, params) : error;
}

/** Внешняя система не ответила или ответила отказом. */
export function unreachable(message: string, detail?: string): IntegrationError {
  return new IntegrationError('integration_unreachable', message, detail);
}
