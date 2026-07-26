import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { LONG_TIMEOUTS, messageFromPayload, toErrorMessage } from './client';

/** Ответ сервера, каким его видит axios. */
function axiosError(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_REQUEST',
    config,
    {},
    {
      status,
      statusText: '',
      data,
      headers: {},
      config,
    } as never,
  );
}

describe('toErrorMessage', () => {
  it('берёт человеческий текст из поля error, когда message нет', () => {
    // Маршруты истории и бэкапов отвечают {error: '…'}; без разбора этого поля
    // пользователь видел служебное «Request failed with status code 400».
    const error = axiosError(400, { error: 'Бинарный файл — построчный откат недоступен' });

    expect(toErrorMessage(error)).toBe('Бинарный файл — построчный откат недоступен');
  });

  it('message важнее error: в конверте Fastify error — имя статуса', () => {
    const error = axiosError(400, {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Имя правила занято',
    });

    expect(toErrorMessage(error)).toBe('Имя правила занято');
  });

  it('пустые и нестроковые поля не подменяют сообщение axios', () => {
    expect(toErrorMessage(axiosError(500, { error: '   ' }))).toBe(
      'Request failed with status code 500',
    );
    expect(toErrorMessage(axiosError(500, { error: { code: 1 } }))).toBe(
      'Request failed with status code 500',
    );
    expect(toErrorMessage(axiosError(500, 'plain text'))).toBe(
      'Request failed with status code 500',
    );
  });

  it('обычные ошибки и прочие значения остаются как есть', () => {
    expect(toErrorMessage(new Error('нет связи'))).toBe('нет связи');
    expect(toErrorMessage('сбой')).toBe('сбой');
  });
});

describe('messageFromPayload', () => {
  it('ничего не находит в пустом теле', () => {
    expect(messageFromPayload(undefined)).toBeUndefined();
    expect(messageFromPayload(null)).toBeUndefined();
    expect(messageFromPayload({})).toBeUndefined();
  });
});

describe('LONG_TIMEOUTS', () => {
  // Клиент, который сдаётся раньше сервера, показывает несуществующую ошибку:
  // прогон доходит до конца и результат записан, а пользователь видит таймаут.
  it('перекрывают бюджеты сервера', () => {
    expect(LONG_TIMEOUTS.assistantRun).toBeGreaterThan(180_000); // assistant-runner
    expect(LONG_TIMEOUTS.providerCheck).toBeGreaterThan(90_000); // provider-check
    expect(LONG_TIMEOUTS.mcpHealth).toBeGreaterThan(180_000); // checkMcpHealth
  });
});
