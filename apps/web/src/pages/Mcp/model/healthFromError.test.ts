import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { healthFromError } from './healthFromError';

const t = (key: string): string => key;

describe('healthFromError', () => {
  it('отказ проверки превращается в видимый статус, а не в тишину', () => {
    // Раньше исключение не ловилось: кнопка переставала крутиться и на карточке
    // не появлялось ничего — ни статуса, ни причины.
    const config = { headers: new AxiosHeaders() };
    const error = new AxiosError(
      'Request failed with status code 500',
      'ERR_BAD_RESPONSE',
      config,
      {},
      {
        status: 500,
        statusText: '',
        data: { message: 'Сервер MCP не запустился' },
        headers: {},
        config,
      } as never,
    );

    expect(healthFromError(error, t)).toEqual({
      health: 'failed',
      detail: 'Сервер MCP не запустился',
    });
  });

  it('таймаут объясняется по-человечески, а не «timeout of 200000ms exceeded»', () => {
    const error = new AxiosError('timeout of 200000ms exceeded', 'ECONNABORTED', {
      headers: new AxiosHeaders(),
    });

    expect(healthFromError(error, t)).toEqual({ health: 'failed', detail: 'mcp.healthTimeout' });
  });

  it('любая другая ошибка тоже доезжает до карточки', () => {
    expect(healthFromError(new Error('Network Error'), t)).toEqual({
      health: 'failed',
      detail: 'Network Error',
    });
  });
});
