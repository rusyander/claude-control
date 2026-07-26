import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { sandboxDeleteFailedText, sandboxErrorText } from './sandboxError';

describe('sandboxErrorText', () => {
  it('достаёт объяснение из конверта ошибки Fastify', () => {
    // Такое тело приходит при 500 из createSandbox: строк `data:` в нём нет,
    // и без разбора экран песочницы оставался пустым.
    const body = JSON.stringify({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Не удалось создать каталог песочницы',
    });

    expect(sandboxErrorText(body)).toBe('Не удалось создать каталог песочницы');
  });

  it('читает поле error, когда message нет (403 от allowlist)', () => {
    expect(sandboxErrorText('{"error":"Forbidden origin"}')).toBe('Forbidden origin');
  });

  it('текст не-JSON тела берётся как есть, но обрезается', () => {
    const html = `<html>${'x'.repeat(1000)}</html>`;

    expect(sandboxErrorText(html)).toHaveLength(300);
  });

  it('пустое тело оставляет решение вызывающему', () => {
    expect(sandboxErrorText('')).toBeUndefined();
    expect(sandboxErrorText('   ')).toBeUndefined();
    expect(sandboxErrorText('{}')).toBeUndefined();
  });
});

/** Ответ сервера, каким его видит axios. */
function axiosError(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_REQUEST',
    config,
    {},
    { status, statusText: '', data, headers: {}, config } as never,
  );
}

/** Подстановка переменных как у i18next — проверяем именно текст на экране. */
const translate = (key: string, vars?: Record<string, unknown>): string =>
  `${key}|${String(vars?.reason ?? '')}`;

describe('sandboxDeleteFailedText', () => {
  it('доносит объяснение сервера целиком: в нём путь к папке с копией доступа', () => {
    // Сервер намеренно отвечает отказом, а не {ok:true}. Без обработчика этот
    // отказ пропадал, и неудалённая песочница выглядела удалённой.
    const message =
      'Песочницу не удалось удалить (EBUSY). В ней осталась копия доступа к аккаунту — удалите папку /home/я/.claude-control/sandboxes/ui-rule-1 вручную.';

    const text = sandboxDeleteFailedText(axiosError(500, { message }), translate);

    expect(text).toContain('sandbox.deleteFailed');
    expect(text).toContain('sandboxes/ui-rule-1');
  });

  it('сеть отвалилась — показываем хотя бы причину axios, а не пустоту', () => {
    expect(sandboxDeleteFailedText(new Error('Network Error'), translate)).toBe(
      'sandbox.deleteFailed|Network Error',
    );
  });
});
