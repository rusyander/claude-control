import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Условный GET для больших списков, которые панель перечитывает часто, а
 * меняются они редко: список разговоров уходит на каждое событие файлового
 * наблюдателя и на каждый возврат в окно, по 70–80 КБ за раз. Валидатор —
 * слабый ETag по хэшу тела: содержимое собирается из многих файлов, и одной
 * даты изменения у него нет. Браузер хранит ответ и на следующий запрос
 * присылает `If-None-Match`; совпало — 304 без тела, и `fetch` в приложении
 * прозрачно получает прежние данные из кэша.
 *
 * `Cache-Control: no-cache` — не «не кэшировать», а «каждый раз спрашивать»:
 * без него браузер мог бы отдать старый список, вообще не ходя на сервер.
 */
export function etagOf(body: string): string {
  return `W/"${createHash('sha1').update(body).digest('base64url')}"`;
}

/**
 * `If-None-Match` может нести несколько валидаторов через запятую или `*`;
 * слабый и сильный вид одного хэша считаются совпавшими — сравнение по
 * содержимому, а не по байтам заголовка.
 */
export function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const strong = etag.replace(/^W\//, '');
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || value === etag || value === strong || `W/${value}` === etag;
  });
}

/** Отдаёт JSON с валидатором либо 304, если клиент уже держит ту же версию. */
export function sendConditional(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): FastifyReply {
  const body = JSON.stringify(payload);
  const etag = etagOf(body);
  reply.header('ETag', etag).header('Cache-Control', 'no-cache');
  if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) {
    return reply.code(304).send();
  }
  return reply.type('application/json; charset=utf-8').send(body);
}
