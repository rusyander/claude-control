import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { startStubModel, type StepContext, type StepLike } from '@agentdeck/stub-model';
import { afterAll, describe, expect, it } from 'vitest';
import { createEconomyWiring } from '../../bootstrap/economy-wiring/index.ts';
import { createToolEventTap } from '../../bootstrap/observer-wiring/tool-events.ts';
import { createSessionRuntime } from '../../bootstrap/session-runtime.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import type { AdapterEvent } from '../adapter.types.ts';
import {
  hookCommand,
  livePin,
  liveRoot,
  liveSpec,
  PERMIT_SERVER,
  type LiveRoot,
} from '../conformance/__fixtures__/live.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from './claude.ts';

/**
 * Живой Claude Code 2.1.310 через переходник, НАСТОЯЩИЕ рантайм сессии, краны наблюдателя и
 * экономики и журнал задачи (этап 11, P146-P149): модель-заглушка зовёт `Agent` (модель `sonnet`),
 * затем фоновый `Bash`; строки журнала — только из потока CLI. Заодно закрывает U3 (какую модель
 * CLI просит для субагента — тело запроса к заглушке) и U11 (разговор свежей сессии = её id ядра,
 * `--session-id`). `AGENTS_PROBE_RECORD=1` — перезаписать `agents-probe.jsonl` (stdout CLI, пути
 * стенда → `<live>`), его проигрыш — `bootstrap/observer-wiring/agent-events.test.ts`.
 */

const present = hasCli(claudeRunFacts.binary.command);
const roots: LiveRoot[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

const CONTEXT: PermitContext = {
  copyRoot: '/copy',
  ownedPaths: [],
  deny: { paths: [], commands: [], mcpTools: [], tools: [] },
  platformPaths: [],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};

const BG_COMMAND = 'node -e "setTimeout(()=>console.log(1),1500)"';

/** Вызовы модели в истории запроса (ответы ассистента с `tool_use`). */
function toolUses(body: Record<string, unknown>): number {
  const messages = (body.messages as { role?: string; content?: unknown }[] | undefined) ?? [];
  let n = 0;
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    n += m.content.filter((b) => (b as { type?: string }).type === 'tool_use').length;
  }
  return n;
}

function step(ctx: StepContext): StepLike {
  const raw = ctx.request.raw;
  // Запрос субагента: его разговор знает только вводную `PROBE_SUB`, не сообщение человека.
  if (raw.includes('PROBE_SUB') && !raw.includes('PROBE_AGENTS')) return 'DONE PROBE_SUB';
  if (!raw.includes('PROBE_AGENTS')) return 'OK';
  const used = toolUses(ctx.request.body);
  if (used === 0)
    return {
      tool: {
        name: 'Agent',
        args: {
          description: 'probe subagent',
          prompt: 'PROBE_SUB answer DONE',
          subagent_type: 'general-purpose',
          model: 'sonnet',
        },
      },
    };
  if (used === 1)
    return {
      tool: {
        name: 'Bash',
        args: { command: BG_COMMAND, description: 'bg', run_in_background: true },
      },
    };
  return 'DONE PROBE_AGENTS';
}

const scrub = (text: string, root: string): string => {
  let out = text;
  for (const form of [root, root.replaceAll('\\', '/'), root.replaceAll('\\', '\\\\')])
    out = out.split(form).join('<live>');
  return out.replace(/[A-Za-z]:(\\\\|\\)Users(\\\\|\\)[^\\"]+/g, '<home>');
};

describe.skipIf(!present)('claude live: agent-history facts reach the journal (stage 11)', () => {
  it('Agent (model sonnet) + background Bash → tool.started before tool.event, agent.spawned/ended, bg.started with the full owner chain then bg.ended exit, subagent usage with its parent; U3 + U11', async () => {
    const live = liveRoot('agents-');
    roots.push(live);
    const stub = await startStubModel({ script: step });
    const registry = createTaskRegistry(tempDir('agents-live-'), deps());
    const task = await registry.create(CREATED);
    const { sessionId } = seedSession(task, { stepKind: 'work' });
    const got = bindingOf(task, sessionId);
    if (!('binding' in got)) throw new Error(got.reason);
    const binding = got.binding;
    const adapter = createClaudeAdapter();
    const spec = liveSpec(live, {
      sessionId,
      endpoint: {
        channel: CLAUDE_CHANNELS[0]!,
        endpoint: {
          baseUrl: stub.baseUrl,
          dialect: 'anthropic-messages',
          model: 'stub-model',
          key: 'k',
        },
      },
      coreHook: hookCommand('core', live.logs.core),
      permitServer: { name: 'agentdeck-permit', tool: 'approve' },
      mcpServers: {
        'agentdeck-permit': {
          command: 'node',
          args: [PERMIT_SERVER],
          env: { PERMIT_DECISION: 'allow', PERMIT_LOG: live.logs.permit },
        },
      },
      env: { pin: livePin(live, { CLAUDE_CONFIG_DIR: join(live.home, '.claude') }) },
    });
    const launched = await adapter.launch(spec);
    if (!launched.ok) throw new Error(launched.reason);
    const handle = launched.handle;
    const seen: AdapterEvent[] = [];
    const notes: string[] = [];
    let wake: (() => void) | null = null;
    const attached = createSessionRuntime({
      note: (e) => notes.push(e),
      observer: createToolEventTap({
        sessionOf: () => ({ mapPermission: (r) => adapter.mapPermission(r), cwd: live.cwd }),
        now: () => performance.now(),
      }),
      economy: createEconomyWiring(),
    }).attach({
      task,
      binding,
      adapter,
      handle,
      context: CONTEXT,
      onEvent: (e) => {
        seen.push(e);
        wake?.();
      },
    });
    const until = async (done: () => boolean, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (!done() && Date.now() < deadline)
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 500);
        });
      return done();
    };
    const has = (type: string) => seen.some((e) => e.type === type);
    try {
      await adapter.send(handle, 'PROBE_AGENTS run the probe', crypto.randomUUID());
      expect(await until(() => has('agent.ended') && has('bg.ended'), 180_000)).toBe(true);
      // Конец фона будит модель ходом CLI — его хвост тоже в записи.
      const ends = seen.filter((e) => e.type === 'turn.ended').length;
      await until(() => seen.filter((e) => e.type === 'turn.ended').length > ends, 30_000);
    } finally {
      await adapter.stop(handle, 'tree');
      await attached.done;
      await stub.close();
    }
    if (process.env.AGENTS_PROBE_RECORD === '1') {
      const out = fileURLToPath(new URL('./__fixtures__/agents-probe.jsonl', import.meta.url));
      writeFileSync(out, scrub(readFileSync(join(handle.dir, 'stdout.log'), 'utf8'), live.root));
    }

    expect(notes.filter((n) => n.endsWith('.tap.failed'))).toEqual([]);
    const lines = readJournalLines(task.dir, task.taskId).lines;
    registry.closeAll();
    const of = (kind: string) => lines.filter((l) => l.kind === kind);
    const data = (l: JournalLine) => l.data as Record<string, unknown>;

    // U11: свежая сессия Claude ведёт разговор под id сессии ядра (`--session-id`).
    const init = seen.find((e) => e.type === 'init');
    expect(init?.type === 'init' ? init.conversationId : null).toBe(sessionId);

    // Каждый вызов: `tool.started` раньше своего `tool.event`.
    const events = of('tool.event');
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const ev of events) {
      const id = data(ev).toolUseId;
      const started = of('tool.started').filter((l) => data(l).toolUseId === id);
      expect(started, `tool.started ${String(id)}`).toHaveLength(1);
      expect(started[0]!.seq).toBeLessThan(ev.seq);
    }

    const agentCall = seen.find(
      (e): e is Extract<AdapterEvent, { type: 'tool.requested' }> =>
        e.type === 'tool.requested' && e.name === 'Agent',
    );
    const bashCall = seen.find(
      (e): e is Extract<AdapterEvent, { type: 'tool.requested' }> =>
        e.type === 'tool.requested' && e.name === 'Bash',
    );
    expect(agentCall && bashCall).toBeTruthy();
    const [spawned] = of('agent.spawned').map(data);
    expect(spawned).toMatchObject({
      sessionId,
      toolUseId: agentCall!.toolUseId,
      parentToolUseId: null,
      kind: 'subagent',
      subagentType: 'general-purpose',
      model: 'sonnet',
      briefExcerpt: 'PROBE_SUB answer DONE',
    });
    const [ended] = of('agent.ended').map(data);
    expect(ended).toMatchObject({ toolUseId: agentCall!.toolUseId, how: 'completed' });
    expect(ended?.usage).not.toBeNull();

    const [bgStarted] = of('bg.started');
    expect(data(bgStarted!)).toMatchObject({
      kind: 'background-shell',
      excerpt: BG_COMMAND,
      ownerChain: {
        taskId: task.taskId,
        stepId: binding.stepId,
        unitId: binding.unitId,
        sessionId,
        toolUseId: bashCall!.toolUseId,
        parentToolUseId: null,
      },
      outputFile: expect.stringMatching(/\.output$/),
    });
    const [bgEnded] = of('bg.ended');
    expect(bgEnded!.seq).toBeGreaterThan(bgStarted!.seq);
    expect(data(bgEnded!)).toMatchObject({
      itemId: data(bgStarted!).itemId,
      how: 'exit',
      exitCode: 0,
    });

    // Ходы субагента в `turn.usage` — с его вызовом-родителем (P149).
    const usage = of('turn.usage').map(data);
    expect(usage.some((u) => u.parentToolUseId === agentCall!.toolUseId)).toBe(true);
    expect(usage.some((u) => u.parentToolUseId === null)).toBe(true);

    // U3: модель, которую CLI просит у маршрута для субагента, — в теле запроса к заглушке.
    const subRequests = stub.requests.filter(
      (r) => r.raw.includes('PROBE_SUB') && !r.raw.includes('PROBE_AGENTS'),
    );
    expect(subRequests.length).toBeGreaterThan(0);
    process.stdout.write(
      `U3 subagent request models: ${JSON.stringify(subRequests.map((r) => r.model))}; main: ${JSON.stringify([...new Set(stub.requests.filter((r) => r.raw.includes('PROBE_AGENTS')).map((r) => r.model))])}\n`,
    );
  }, 300_000);
});
