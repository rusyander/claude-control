import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../adapters/index.ts';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { ensureCoreHome } from '../platform/core-home.ts';
import type { PermitContext } from '../policy/permit/permit.types.ts';
import { bootCore } from './boot.ts';

/**
 * Книга окон одна на ядро (G7) на настоящей загрузке: факт окна из потока прикреплённой сессии
 * (кран экономики рантайма сессий) виден и экономике исполнителя, которую загрузка отдаёт каждому
 * `runTask`, и `/v1/health` по настоящему порту. Подменён только переходник (внешняя граница — CLI).
 */

const CONTEXT: PermitContext = {
  copyRoot: '/copy',
  ownedPaths: [],
  deny: { paths: [], commands: [], mcpTools: [], tools: [] },
  platformPaths: [],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};

function fakeAdapter(events: AdapterEvent[]): CliAdapter {
  return {
    id: 'claude',
    events: async function* () {
      for (const event of events) yield event;
    },
    mapPermission: () => ({ action: 'other', target: '', tool: '', display: '' }),
  } as unknown as CliAdapter;
}

describe('core boot economy', () => {
  it('G7 one WindowBook per core: a window fact from a session stream reaches the run economy and /v1/health alike', async () => {
    const home = join(tempDir('boot-econ-'), 'core');
    const layout = ensureCoreHome(home);
    const seed = createTaskRegistry(layout.tasks, deps());
    const created = await seed.create(CREATED);
    seed.closeAll();
    const core = await bootCore({ home, build: 'boot-test', loop: false });
    try {
      const task = core.registry.live(created.taskId);
      if (!task) throw new Error('task not live');
      const { sessionId } = seedSession(task, { stepKind: 'work' });
      const bound = bindingOf(task, sessionId);
      if (!('binding' in bound)) throw new Error(bound.reason);
      const resetAt = Date.now() + 3_600_000;
      const attached = core.sessions.attach({
        task,
        binding: bound.binding,
        adapter: fakeAdapter([
          {
            type: 'window',
            limitKind: 'window',
            usedPct: 95,
            resetAt,
            window: 'five_hour',
            warning: false,
            refusal: false,
          },
        ]),
        handle: { sessionId } as SessionHandle,
        context: CONTEXT,
        resumed: false,
      });
      await attached.done;

      // Маршрут сессии затравки — `stub-1`: 95 % окна — «держать» у исполнителя.
      const economy = core.economy.windows('stub-1');
      expect(economy).toEqual([
        expect.objectContaining({ routeId: 'stub-1', limitKind: 'window', verdict: 'held' }),
      ]);
      const token = readFileSync(layout.token, 'utf8').trim();
      const res = await fetch(`${core.url}/v1/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { window: { routes: { routeId: string }[] } };
      expect(body.window.routes).toEqual([
        expect.objectContaining({ routeId: 'stub-1', verdict: 'held', usedPct: 95 }),
      ]);
      expect(core.windows.routes()).toEqual(['stub-1']);
    } finally {
      await core.stop();
    }
  }, 60_000);
});
