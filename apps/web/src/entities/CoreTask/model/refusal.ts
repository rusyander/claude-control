import { CORE_PROXY_CODES, type CoreProxyCode } from '@agentdeck/contracts/core/supervisor';

/**
 * Отказ прокладки ядра (`/api/core/*`): ядра нет, ядро не подтвердило себя (bearer не ушёл),
 * ядро молчит, ядро поднимается надзором панели, надзор сдался (этап 10). Страница рисует по
 * коду свою карточку, а не общий «запрос не удался».
 */
export type CoreRefusal = CoreProxyCode;

const REFUSALS = new Set<string>(CORE_PROXY_CODES);

/** Код отказа из ошибки запроса (axios: `response.data.code`) или из тела ответа. */
export function coreRefusalOf(error: unknown): CoreRefusal | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const response = (error as { response?: { data?: unknown } }).response;
  const body = response ? response.data : error;
  if (typeof body !== 'object' || body === null) return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' && REFUSALS.has(code) ? (code as CoreRefusal) : undefined;
}
