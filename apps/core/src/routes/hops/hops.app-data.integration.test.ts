import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../hop-host/__fixtures__/hop-stand.ts';
import { startHopHost, type RunningHopHost } from '../../hop-host/host.ts';
import { ensureHopHost, HopHostError } from './hops.ts';

/**
 * Живой хост звеньев с другим каталогом данных панели (решение W2b): `ensureHopHost` отказывает
 * названной ошибкой и НЕ перезапускает хост — им пользуются сеансы других задач. Хост настоящий
 * (строка в `procs.json`, токен управления, статус по протоколу), каталоги — временные.
 */

let host: RunningHopHost;
let home: string;
let appData: string;

beforeAll(async () => {
  home = tempDir('hop-appdata-home-');
  appData = tempDir('hop-appdata-panel-');
  host = await startHopHost({ home, panelAppData: appData });
});
afterAll(async () => {
  await host.close();
});

describe('ensureHopHost: a live host with other panel data is refused, never restarted (W2b)', () => {
  it('same panel data → the live host; other or none → panel_data_mismatch, host untouched', async () => {
    const same = await ensureHopHost({ home, panelAppData: appData });
    expect(same.launched).toBe(false);
    expect(same.pid).toBe(process.pid);
    const other = ensureHopHost({ home, panelAppData: tempDir('hop-appdata-other-') });
    await expect(other).rejects.toBeInstanceOf(HopHostError);
    await expect(other).rejects.toMatchObject({ code: 'panel_data_mismatch' });
    await expect(ensureHopHost({ home })).rejects.toMatchObject({ code: 'panel_data_mismatch' });
    // Хост не тронут: тот же процесс отвечает тем же каталогом.
    const again = await ensureHopHost({ home, panelAppData: appData });
    expect(again.url).toBe(same.url);
  });
});
