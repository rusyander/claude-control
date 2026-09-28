import { afterEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver } from '@tanstack/react-query';
import { splitTasksMutation, type SplitTasksBody } from '@entities/ChatSplit';
import { apiClient } from '@shared/api/client';
import { clearToasts, getToasts } from '@shared/lib/toast';
import { queryClient } from './queryClient';

/**
 * Живой прогон 25.09 (D2): на 409 «план ещё идёт» вставали два тоста — сырой
 * текст сервера из общего MutationCache и предложение отменить план от вызова.
 * Проверяется настоящий общий клиент запросов: отказ разбирает вызов, а общий
 * тост молчит.
 */
describe('разделение — отказ сервера', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearToasts();
  });

  it('общий тост ошибки не встаёт — отказ показывает вызов', async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('Разделение этого разговора ещё идёт'));
    const observer = new MutationObserver(queryClient, splitTasksMutation);

    await observer.mutate({} as SplitTasksBody).catch(() => undefined);

    expect(observer.getCurrentResult().isError).toBe(true);
    expect(getToasts()).toEqual([]);
  });
});
