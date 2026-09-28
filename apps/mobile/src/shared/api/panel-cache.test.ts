import { describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { forgetPanelData } from './panel-cache';

describe('forgetPanelData', () => {
  it('смонтированный экран теряет данные прежней панели', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let panel = 'old';
    const observer = new QueryObserver(client, {
      queryKey: ['remote'],
      queryFn: () => Promise.resolve(panel),
      enabled: () => panel !== '',
    });
    const seen: Array<string | undefined> = [];
    const stop = observer.subscribe((result) => seen.push(result.data));
    await client.fetchQuery({ queryKey: ['remote'], queryFn: () => Promise.resolve(panel) });
    expect(observer.getCurrentResult().data).toBe('old');

    // «Отключить»: адреса нет, запрос выключен — на экране не должно остаться старого.
    panel = '';
    await forgetPanelData(client);
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(seen.at(-1)).toBeUndefined();
    stop();
  });
});
