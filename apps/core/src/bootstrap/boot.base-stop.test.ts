import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliAdapter, SessionHandle } from '../adapters/index.ts';
import { installReplay } from '../adapters/conformance/__fixtures__/replay.ts';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { ensureCoreHome } from '../platform/core-home.ts';
import { bootCore } from './boot.ts';
import type { Prepared } from './session-road/road.types.ts';

/**
 * Остановка ядра снимает фоновую пробу базы (G9) на настоящей загрузке: замер ядра (тот, что
 * дирижёр зовёт после `started`), версия — `--version` подставного `claude` с PATH пина, проба —
 * настоящий `probeOnStub` с заглушкой модели на петле. Подменён только переходник (граница — CLI):
 * его ход не кончается, пока пробу не снимут.
 */

describe('core stop and the background base probe', () => {
  it('core.stop aborts a probe in flight and returns only after the probe CLI is stopped as a tree', async () => {
    const home = join(tempDir('boot-base-stop-'), 'core');
    const layout = ensureCoreHome(home);
    const seed = createTaskRegistry(layout.tasks, deps());
    const created = await seed.create(CREATED);
    seed.closeAll();
    const core = await bootCore({ home, build: 'boot-test', loop: false });
    const stops: string[] = [];
    let launched = 0;
    let release: () => void = () => undefined;
    const adapter = {
      id: 'claude',
      // Версию для ключа базы читает адаптер своей командой; без неё замер не начинается.
      versionCommand: 'claude',
      launch: async () => {
        launched += 1;
        return { ok: true, handle: { sessionId: 'probe' }, layer: {} };
      },
      send: async () => ({ dup: false }),
      events: async function* () {
        await new Promise<void>((r) => (release = r));
        // Ход не кончается: поток пуст, пока пробу не снимут.
        yield* [];
      },
      stop: async (_h: SessionHandle, mode: string) => {
        // Снятие дерева — не мгновенно: остановка ядра обязана его дождаться.
        await new Promise((r) => setTimeout(r, 50));
        stops.push(mode);
        release();
      },
    } as unknown as CliAdapter;
    const bin = tempDir('boot-base-stop-bin-');
    installReplay(bin, 'claude');
    const pin: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete pin.Path;
    pin.PATH = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;
    let stopped = false;
    try {
      const task = core.registry.live(created.taskId);
      if (!task) throw new Error('task not live');
      const { sessionId } = seedSession(task, { stepKind: 'work' });
      const p = {
        adapter,
        start: { stepKind: 'work', sessionId },
        spec: {
          dir: tempDir('boot-base-stop-dir-'),
          cwd: tempDir('boot-base-stop-cwd-'),
          env: { pin },
          layer: { hooks: 'off', skills: 'on' },
          tools: 'all',
          endpoint: {
            channel: { via: 'env' },
            endpoint: { baseUrl: 'http://127.0.0.1:1', dialect: 'anthropic-messages' },
          },
        },
        mcpHash: 'a'.repeat(64),
      } as unknown as Prepared;
      expect(core.measureBase(task, p)).toBe(true);
      for (let i = 0; i < 500 && launched === 0; i += 1)
        await new Promise((r) => setTimeout(r, 10));
      expect(launched).toBe(1);
      await core.stop();
      stopped = true;
      expect(stops).toEqual(['tree']);
      expect(task.state.bases).toHaveLength(0);
    } finally {
      if (!stopped) await core.stop();
    }
  }, 30_000);
});
