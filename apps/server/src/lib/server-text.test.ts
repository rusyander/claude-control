import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { codeOf, coded, registerCodedErrors } from './server-text.ts';

class NotFound extends Error {
  readonly statusCode = 404;
  readonly code = 'not_found';
}

async function serve(error: Error) {
  const app = Fastify();
  registerCodedErrors(app);
  app.get('/boom', () => {
    throw error;
  });
  const response = await app.inject({ method: 'GET', url: '/boom' });
  await app.close();
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

describe('код текста у ошибки', () => {
  it('coded вешает код, codeOf его снимает; незнакомый код не пропускается', () => {
    const error = coded(new Error('Сервер не найден'), 'mcp-server-not-found');
    expect(codeOf(error)).toEqual({ messageCode: 'mcp-server-not-found' });
    expect(codeOf(coded(new Error('x'), 'integration-not-found', { id: 'jira' }))).toEqual({
      messageCode: 'integration-not-found',
      params: { id: 'jira' },
    });
    expect(codeOf(Object.assign(new Error('x'), { messageCode: 'no-such-code' }))).toEqual({});
    expect(codeOf(undefined)).toEqual({});
  });

  it('не пойманная маршрутом ошибка с кодом уезжает с кодом и своим статусом', async () => {
    const { status, body } = await serve(
      coded(new NotFound('Группа не найдена'), 'group-not-found'),
    );
    expect(status).toBe(404);
    expect(body).toEqual({
      statusCode: 404,
      code: 'not_found',
      error: 'Not Found',
      message: 'Группа не найдена',
      messageCode: 'group-not-found',
    });
  });

  it('ошибка без кода — прежний ответ Fastify по умолчанию', async () => {
    const { status, body } = await serve(new NotFound('Группа не найдена'));
    expect(status).toBe(404);
    expect(body).toEqual({
      statusCode: 404,
      code: 'not_found',
      error: 'Not Found',
      message: 'Группа не найдена',
    });
  });
});
