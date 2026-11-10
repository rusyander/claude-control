import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { integrationKeyId } from '@agentdeck/keys/integration-keys';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { afterEach, describe, expect, it } from 'vitest';
import { taskCard } from '../conductor/board/stage.ts';
import { bootCore, type BootedCore } from './boot.ts';
import { closeWorlds, linesOf, world } from './forge-wiring/__fixtures__/answer-world.ts';

/**
 * Обход конца MR на НАСТОЯЩЕЙ загрузке ядра (W2-D, B10b): `boot-core.ts` даёт доске форж каталога
 * панели (`forgeFor`), и обход при старте пишет `publish.mr-state` слитого MR — карточка уходит в
 * «Влит». Без этой проводки доска пишет «mr-state sweep off: no forge wired» и карточка стоит в «MR»
 * навсегда. Настоящее всё: публикатор стенда ответов, голый «сервер», заглушка форжа по HTTP,
 * настройки форжа панели в `state.json` временного каталога, ключ — настоящим `@agentdeck/keys`.
 */

const cores: BootedCore[] = [];
afterEach(async () => {
  for (const core of cores.splice(0)) await core.stop().catch(() => undefined);
  await closeWorlds();
});

async function until(probe: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('MR-state sweep through the real boot wiring', { timeout: 120_000 }, () => {
  it('a published task whose MR was merged at the forge moves to merged on the start-time sweep', async () => {
    const w = await world();
    const taskId = w.source.taskId;
    w.stub.act('reviewer', { type: 'merge', mrIid: w.mrIid });
    // Адрес пуша — у хоста заглушки: так форж панели узнаёт свой сайт по remote задачи.
    w.st.g(w.st.main, 'config', 'remote.origin.pushurl', `${w.stub.url}/acme/app.git`);
    const appData = join(w.st.root, 'panel');
    mkdirSync(appData, { recursive: true });
    writeFileSync(
      join(appData, 'state.json'),
      JSON.stringify({
        settings: { integrations: { gitlab: { enabled: true, baseUrl: w.stub.url, repo: '101' } } },
      }),
    );
    setStoredKey(appData, integrationKeyId('gitlab'), w.stub.tokens['publisher']!);
    w.registry.closeAll();

    const core = await bootCore({
      home: w.layout.root,
      build: 'mr-sweep-test',
      panelAppData: appData,
      loop: false,
    });
    cores.push(core);
    await until(() => linesOf(w.source, 'publish.mr-state').length > 0, 'publish.mr-state');
    expect(linesOf(w.source, 'publish.mr-state')).toEqual([
      { unitId: w.unitId, state: 'merged', at: expect.any(Number) },
    ]);
    const view = core.registry.live(taskId)?.state ?? core.registry.view(taskId);
    expect(view && taskCard(view).column).toBe('merged');
  });
});
