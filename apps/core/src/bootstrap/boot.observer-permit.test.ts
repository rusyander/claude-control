import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../adapters/index.ts';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { ensureCoreHome } from '../platform/core-home.ts';
import { createLivenessProbe, fakeProcessTable } from '../platform/process-identity.ts';
import type { PermitContext } from '../policy/permit/permit.types.ts';
import { bootCore } from './boot.ts';

/**
 * Сторож тишины на НАСТОЯЩЕЙ загрузке ядра (этап 8, F9): вопрос о праве, который ядро ещё решает
 * (`SessionRuntime.permitPending` ← ворот права сессии), — ожидание ядра, а не тишина модели;
 * загрузка обязана отдать этот признак наблюдателю. Ход сессии идёт, поток молчит: пока вопрос
 * ждёт — сессия `live`; вопрос кончился (таймер ожидания) — следующий тик пишет `silent`.
 * Подменены переходник (граница CLI) и таблица процессов; ворот, рантайм, сторож и таймер тиков —
 * настоящие.
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

/** Ход начат, дальше поток молчит до `release` — как CLI, ждущий ответа о праве. */
function quietAdapter(release: Promise<void>): CliAdapter {
  const turn = { type: 'turn.started', attribution: 'a', origin: 'sequence' } as AdapterEvent;
  return {
    id: 'claude',
    events: async function* () {
      yield turn;
      await release;
    },
    mapPermission: () => ({ action: 'other', target: '', tool: '', display: '' }),
  } as unknown as CliAdapter;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('core boot: the stall watch hears the permission gate', () => {
  it('stage 8 boot permitPending: a question the core still decides keeps a quiet session live past the silence threshold; once it ends the next tick marks it silent', async () => {
    const home = join(tempDir('boot-obs-permit-'), 'core');
    const layout = ensureCoreHome(home);
    const seed = createTaskRegistry(layout.tasks, deps());
    const created = await seed.create(CREATED);
    seed.closeAll();
    const table = fakeProcessTable([]);
    const core = await bootCore({
      home,
      build: 'boot-test',
      loop: false,
      observer: { silentAfterMs: 200, stallDefaultMs: 600_000, probe: createLivenessProbe(table) },
    });
    let release = (): void => {};
    const released = new Promise<void>((r) => (release = r));
    try {
      const task = core.registry.live(created.taskId);
      if (!task) throw new Error('task not live');
      const { sessionId } = seedSession(task, { stepKind: 'work' });
      const bound = bindingOf(task, sessionId);
      if (!('binding' in bound)) throw new Error(bound.reason);
      core.sessions.attach({
        task,
        binding: bound.binding,
        adapter: quietAdapter(released),
        handle: { sessionId } as SessionHandle,
        context: CONTEXT,
        resumed: false,
      });
      const gate = core.sessions.permitDeps(task, bound.binding)?.gate;
      if (!gate) throw new Error('session not attached');
      // Вопрос пришёл раньше запроса потока: ядро решает 2,5 с — два с лишним тика по 1 с.
      const asked = gate.claim(sessionId, 'toolu_1', 'Bash', 2_500);
      expect(core.sessions.permitPending(sessionId)).toBe(true);
      const states = new Set<string>();
      let done = false;
      void asked.then(() => (done = true));
      while (!done) {
        states.add(task.state.sessions[sessionId]?.state ?? 'none');
        await sleep(25);
      }
      // Тишина в 10 раз дольше порога, но вопрос ждал ядро — сессия ни разу не ушла из `live`.
      expect([...states]).toEqual(['live']);
      expect(core.sessions.permitPending(sessionId)).toBe(false);
      // Near-miss той же сессии: вопроса нет — ближайший тик называет тишину.
      const deadline = Date.now() + 5_000;
      while (task.state.sessions[sessionId]?.state === 'live' && Date.now() < deadline) {
        await sleep(25);
      }
      const moves = readJournalLines(task.dir, task.taskId)
        .lines.filter((l) => l.kind === 'session.transition' && l.sessionId === sessionId)
        .map((l) => (l.data as { event: string }).event);
      // `spawned` — затравка сессии; после неё сторож написал ровно одну тишину.
      expect(moves).toEqual(['spawned', 'silent']);
    } finally {
      release();
      await core.stop();
    }
  }, 60_000);
});
