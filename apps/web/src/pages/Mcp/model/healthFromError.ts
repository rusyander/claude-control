import axios from 'axios';
import { toErrorMessage } from '@shared/api/client';
import type { HealthResult } from '../McpServerCard.types';

/**
 * Отказ проверки связи, показанный как результат проверки.
 *
 * Раньше исключение здесь никто не ловил: кнопка переставала крутиться, и на
 * карточке не появлялось ничего — ни статуса, ни причины. Любой отказ (таймаут,
 * 404, 500) обязан доехать до пользователя, поэтому превращаем его в
 * `failed` с текстом.
 *
 * `t` передаётся снаружи: разбор ошибки — чистая логика, а словарь живёт в
 * компоненте.
 */
export function healthFromError(error: unknown, t: (key: string) => string): HealthResult {
  // Оборванный по таймауту запрос axios описывает служебно
  // («timeout of 200000ms exceeded») — подсказываем, что делать.
  const isTimeout =
    axios.isAxiosError(error) && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT');

  return { health: 'failed', detail: isTimeout ? t('mcp.healthTimeout') : toErrorMessage(error) };
}
