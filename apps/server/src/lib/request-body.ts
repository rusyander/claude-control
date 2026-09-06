import type { FastifyReply } from 'fastify';
import type { ZodError, ZodType } from 'zod';

export interface BodyIssue {
  /** Путь до поля через точку: `files.0.name`; пусто — не так само тело. */
  path: string;
  message: string;
}

/** Разбор ошибки zod в список «поле → что не так» — для понятного ответа 400. */
export function issuesOf(error: ZodError): BodyIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/**
 * Проверить тело мутирующего маршрута схемой. Прошло — данные с типом из схемы;
 * нет — уже отправленный 400 `{ code: 'invalid_body', message, issues }`, где
 * каждый `issue.path` называет поле, и `undefined`, чтобы вызывающий вернул
 * `reply`. Так битое тело (телефон старой версии, `curl` руками) не доходит до
 * домена и не падает там с 500 без единого намёка, что именно не так.
 */
export function parseBody<T>(
  schema: ZodType<T>,
  body: unknown,
  reply: FastifyReply,
): T | undefined {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issues = issuesOf(parsed.error);
  const fields = [...new Set(issues.map((issue) => issue.path || '(тело)'))];
  void reply.code(400).send({
    code: 'invalid_body',
    message: `Запрос не принят: неверно задано ${fields.join(', ')}.`,
    issues,
  });
  return undefined;
}
