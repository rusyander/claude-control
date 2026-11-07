import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentNodeDetail, AgentsListReply } from '@agentdeck/contracts/core/agents';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import {
  agentsGoldenRows,
  BG_ITEM,
  SUB,
  type GoldenIds,
} from '../../journal/reduce/__fixtures__/agents-golden.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { ensureCoreHome } from '../../platform/core-home.ts';
import { identityOfPid } from '../../platform/process-identity.ts';
import { bootCore, type BootedCore } from '../boot.ts';
import { seedLiveSession } from './__fixtures__/seed.ts';

/**
 * «Агенты» чата панели (этап 11, W3-17) на НАСТОЯЩЕЙ загрузке ядра: панель спрашивает список всех
 * агентов фильтром `conversationId` = id разговора чата. Новый чат зовётся первым сеансом ядра
 * (`--session-id`), продолженный — `task.created.resume.conversationId`; оба обязаны находить свою
 * задачу и только её. Фоновая работа несёт код выхода `bg.ended.exitCode` — экран пишет
 * «завершён (код 0)».
 */

const RESUMED = 'conv-old-1';

const booted: BootedCore[] = [];
afterEach(async () => {
  for (const core of booted.splice(0)) await core.stop();
});

function writeGolden(task: LiveTask, ids: GoldenIds): void {
  for (const row of agentsGoldenRows(ids)) {
    task.append({
      kind: row.kind,
      actor: 'core',
      ...(row.sessionId ? { sessionId: row.sessionId } : {}),
      data: row.data,
    } as never);
  }
}

async function stand() {
  const home = join(tempDir('agents-conv-'), 'core');
  const layout = ensureCoreHome(home);
  const seed = createTaskRegistry(layout.tasks, deps());
  const me = await identityOfPid(process.pid);
  if (!('value' in me)) throw new Error('own process identity unread');
  const fresh = await seed.create({ ...CREATED, title: 'new chat' });
  const freshIds = seedLiveSession(fresh, me.value);
  const resumed = await seed.create({
    ...CREATED,
    title: 'resumed chat',
    resume: { adapter: 'claude', conversationId: RESUMED },
  });
  const resumedIds = seedLiveSession(resumed, me.value);
  writeGolden(fresh, freshIds);
  writeGolden(resumed, resumedIds);
  seed.closeAll();
  const core = await bootCore({ home, build: 'agents-test', loop: false, agents: { tickMs: 0 } });
  booted.push(core);
  const token = readFileSync(layout.token, 'utf8').trim();
  const get = async <T>(path: string): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${core.url}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { get, freshIds, resumedIds };
}

describe('agents of a panel chat: conversation filter over a booted core (W3-17)', () => {
  it('new chat = its first core session id, resumed chat = resume.conversationId; each finds only its task, an unknown one finds nothing', async () => {
    const { get, freshIds, resumedIds } = await stand();
    const q = (id: string) => `/v1/agents?conversationId=${encodeURIComponent(id)}`;

    const fresh = await get<AgentsListReply>(q(freshIds.sessionId));
    expect(fresh.status).toBe(200);
    expect(new Set(fresh.body.nodes.map((n) => n.taskId))).toEqual(new Set([freshIds.taskId]));
    expect(fresh.body.nodes.map((n) => n.nodeId)).toEqual(expect.arrayContaining([SUB, BG_ITEM]));

    const resumed = await get<AgentsListReply>(q(RESUMED));
    expect(new Set(resumed.body.nodes.map((n) => n.taskId))).toEqual(new Set([resumedIds.taskId]));

    const none = await get<AgentsListReply>(q('conv-nobody'));
    expect(none.body).toEqual({ nodes: [], truncated: false });
  });

  it('a finished background item carries its exit code into the node detail', async () => {
    const { get, freshIds } = await stand();
    const detail = await get<AgentNodeDetail>(
      `/v1/tasks/${freshIds.taskId}/agents/${encodeURIComponent(BG_ITEM)}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.node.status).toBe('completed');
    expect(detail.body.node.exitCode).toBe(0);
    expect(detail.body.bg[0]).toMatchObject({ itemId: BG_ITEM, how: 'exit', exitCode: 0 });
    // Строка списка несёт код сама: «завершён (код 0)» без запроса узла.
    const list = await get<AgentsListReply>(`/v1/agents?conversationId=${freshIds.sessionId}`);
    expect(list.body.nodes.find((n) => n.nodeId === BG_ITEM)?.exitCode).toBe(0);
    expect(list.body.nodes.find((n) => n.nodeId === SUB)).not.toHaveProperty('exitCode');
  });
});
