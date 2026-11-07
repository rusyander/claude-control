import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentNodeDetail,
  AgentsListReply,
  AgentsStreamEvent,
  AgentTreeView,
} from '@agentdeck/contracts/core/agents';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import {
  agentsGoldenRows,
  agentsGoldenTree,
  BG_ITEM,
  SUB,
  TEMP_FILE,
  timeless,
  type GoldenIds,
} from '../../journal/reduce/__fixtures__/agents-golden.ts';
import { AGENT_SLICE_KINDS } from '../../journal/reduce/agents-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { ensureCoreHome } from '../../platform/core-home.ts';
import { OUTPUT_TAIL_BYTES } from '../../platform/output-tail.ts';
import { identityOfPid } from '../../platform/process-identity.ts';
import { bootCore, type BootedCore } from '../boot.ts';
import { seedLiveSession } from './__fixtures__/seed.ts';

/**
 * История агентов на НАСТОЯЩЕЙ загрузке ядра (этап 11, P146-P147, P61): золотой журнал формы
 * переходника пишется настоящим писателем в живую задачу, `/v1/*agents*` по настоящему HTTP —
 * дерево = золото, поток отдаёт запуск субагента раньше его конца и повторяет строку `after+1`,
 * выгрузка и хвост вывода без секрета, временный путь в `files[]` дошёл как есть (U4).
 * Секрет посажен мимо маски: задача заведена реестром без маски (`NO_MASK`), ядро — со своей.
 */

const VENDOR_KEY = 'sk-ant-api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNm';

const booted: BootedCore[] = [];
afterEach(async () => {
  for (const core of booted.splice(0)) await core.stop();
});

interface Stand {
  core: BootedCore;
  task: LiveTask;
  ids: GoldenIds;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  outputFile: string;
}

async function stand(): Promise<Stand> {
  const home = join(tempDir('agents-api-'), 'core');
  const layout = ensureCoreHome(home);
  const seed = createTaskRegistry(layout.tasks, deps());
  const created = await seed.create({ ...CREATED, title: `deploy with ${VENDOR_KEY}` });
  const me = await identityOfPid(process.pid);
  if (!('value' in me)) throw new Error('own process identity unread');
  const ids = seedLiveSession(created, me.value);
  seed.closeAll();
  const core = await bootCore({ home, build: 'agents-test', loop: false, agents: { tickMs: 0 } });
  booted.push(core);
  const task = core.registry.live(created.taskId);
  if (!task) throw new Error('task not live');
  const token = readFileSync(layout.token, 'utf8').trim();
  const outputFile = join(home, 'bash_bg_1.output');
  writeFileSync(outputFile, `listening on 5173\nAuthorization: Bearer ${VENDOR_KEY}\n`);
  return {
    core,
    task,
    ids,
    outputFile,
    get: (path, headers = {}) =>
      fetch(`${core.url}${path}`, { headers: { authorization: `Bearer ${token}`, ...headers } }),
  };
}

function writeGolden(st: Stand, without: readonly string[] = []): void {
  for (const row of agentsGoldenRows(st.ids)) {
    if (without.includes(row.kind)) continue;
    const data =
      row.kind === 'bg.started' ? { ...(row.data as object), outputFile: st.outputFile } : row.data;
    st.task.append({
      kind: row.kind,
      actor: 'core',
      ...(row.sessionId ? { sessionId: row.sessionId } : {}),
      data,
    } as never);
  }
}

/** Кадры SSE до `end` (поток закрывает ядро) или срока. */
async function frames(
  res: Response,
  timeoutMs = 10_000,
): Promise<{ id: number; event: AgentsStreamEvent }[]> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  const out: { id: number; event: AgentsStreamEvent }[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut = buf.indexOf('\n\n');
      while (cut >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const id = /^id: (\d+)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (id && data) out.push({ id: Number(id), event: JSON.parse(data) as AgentsStreamEvent });
        cut = buf.indexOf('\n\n');
      }
    }
  } finally {
    clearTimeout(deadline);
  }
  return out;
}

const seqOf = (
  st: Stand,
  kind: string,
  pred: (d: Record<string, unknown>) => boolean = () => true,
) =>
  readFileSync(join(st.core.registry.tasksDir, st.ids.taskId, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { seq: number; kind: string; data: Record<string, unknown> })
    .find((l) => l.kind === kind && pred(l.data))?.seq;

const API = 'stage 11 agent history over the booted core API (P146-P147, P61)';

describe(API, () => {
  it('GET tree = golden; node detail pages calls, keeps the temp path verbatim, masks the output tail', async () => {
    const st = await stand();
    writeGolden(st);
    const res = await st.get(`/v1/tasks/${st.ids.taskId}/agents`);
    expect(res.status).toBe(200);
    const view = (await res.json()) as AgentTreeView;
    expect(timeless(view.nodes)).toEqual(agentsGoldenTree(st.ids));
    expect(view.seq).toBeGreaterThan(0);

    const running = (await (
      await st.get(`/v1/tasks/${st.ids.taskId}/agents?kind=subagent&model=sonnet`)
    ).json()) as AgentTreeView;
    expect(running.nodes.map((n) => n.nodeId)).toEqual([SUB]);
    expect((await st.get(`/v1/tasks/${st.ids.taskId}/agents?kind=robot`)).status).toBe(400);

    const main = (await (
      await st.get(`/v1/tasks/${st.ids.taskId}/agents/${st.ids.sessionId}`)
    ).json()) as AgentNodeDetail;
    expect(main.files).toEqual([TEMP_FILE]);
    expect(main.toolCalls.items.map((c) => c.tool)).toEqual(['Read', 'Agent', 'Bash']);
    const bg = (await (
      await st.get(`/v1/tasks/${st.ids.taskId}/agents/${BG_ITEM}`)
    ).json()) as AgentNodeDetail;
    expect(bg.outputTail?.text).toContain('listening on 5173');
    expect(bg.outputTail?.text).not.toContain(VENDOR_KEY);
    // Окно хвоста режет строку ключа посреди: обломок без «sk-ant-…» маска не узнаёт — его нет.
    writeFileSync(
      st.outputFile,
      `${'x'.repeat(100)}\nAuthorization: Bearer ${VENDOR_KEY}\n${'y'.repeat(OUTPUT_TAIL_BYTES - 21)}`,
    );
    const cut = (await (
      await st.get(`/v1/tasks/${st.ids.taskId}/agents/${BG_ITEM}`)
    ).json()) as AgentNodeDetail;
    expect(cut.outputTail?.truncated).toBe(true);
    expect(cut.outputTail?.text).not.toContain(VENDOR_KEY.slice(-20));
    expect(cut.outputTail?.text.startsWith('y')).toBe(true);
    expect((await st.get(`/v1/tasks/${st.ids.taskId}/agents/nope`)).status).toBe(404);
    // Курсор страницы вызовов — только цифры: иначе 400 с кодом, а не тихо первая страница.
    for (const bad of ['abc', '1e3', '-1', ' ', '1.5']) {
      const res = await st.get(
        `/v1/tasks/${st.ids.taskId}/agents/${st.ids.sessionId}?page=${encodeURIComponent(bad)}`,
      );
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('bad-page');
    }
    // Курсор за концом — пустая страница без следующей, а не снова первая.
    const past = (await (
      await st.get(`/v1/tasks/${st.ids.taskId}/agents/${st.ids.sessionId}?page=999`)
    ).json()) as AgentNodeDetail;
    expect(past.toolCalls).toEqual({ items: [], next: null });

    const list = (await (await st.get('/v1/agents')).json()) as AgentsListReply;
    expect(list.nodes).toHaveLength(4);
    expect(list.truncated).toBe(false);
    const other = (await (await st.get('/v1/agents?groupId=g-1')).json()) as AgentsListReply;
    expect(other.nodes).toEqual([]);
    const ghost = '01920000-0000-7000-8000-00000000ffff';
    expect((await st.get(`/v1/tasks/${ghost}/agents`)).status).toBe(404);
    expect((await st.get(`/v1/tasks/${ghost}/agents/stream`)).status).toBe(404);
  }, 60_000);

  it('a running background work: its unfinished last line is held back by the node detail; ended — served whole', async () => {
    const st = await stand();
    writeGolden(st, ['bg.ended']);
    // Ключ пишется двумя кусками: пока работа идёт, недописанная строка не уходит обломком мимо маски.
    writeFileSync(
      st.outputFile,
      `listening on 5173\nAuthorization: Bearer ${VENDOR_KEY.slice(0, 14)}`,
    );
    const detail = async () =>
      (await (
        await st.get(`/v1/tasks/${st.ids.taskId}/agents/${BG_ITEM}`)
      ).json()) as AgentNodeDetail;
    expect((await detail()).outputTail?.text).toBe('listening on 5173\n');
    st.task.append({
      kind: 'bg.ended',
      actor: 'core',
      data: { itemId: BG_ITEM, how: 'exit', exitCode: 0, endedAt: 1_700_000_005_000 },
    } as never);
    expect((await detail()).outputTail?.text).toContain('Authorization: Bearer');
  }, 60_000);

  it('the SSE follower gets agent.spawned before agent.ended, then end; Last-Event-ID replays the row at after+1', async () => {
    const st = await stand();
    const live = await st.get(`/v1/tasks/${st.ids.taskId}/agents/stream`);
    expect(live.status).toBe(200);
    expect(live.headers.get('content-type')).toContain('text/event-stream');
    const got = frames(live);
    writeGolden(st);
    st.task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    const seen = await got;
    expect(seen[0]?.event.type).toBe('snapshot');
    const subFrames = seen.flatMap((f) =>
      f.event.type === 'node' && f.event.node.nodeId === SUB ? [f.event.node.status] : [],
    );
    expect(subFrames[0]).toBe('running');
    expect(subFrames.at(-1)).toBe('completed');
    expect(seen.at(-1)?.event.type).toBe('end');
    const ids = seen.map((f) => f.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);

    const spawnedAt = seqOf(st, 'agent.spawned', (d) => d.toolUseId === SUB) as number;
    for (const headers of [
      { 'last-event-id': String(spawnedAt - 1) },
      {} as Record<string, string>,
    ]) {
      const path = `/v1/tasks/${st.ids.taskId}/agents/stream${
        'last-event-id' in headers ? '' : `?after=${spawnedAt - 1}`
      }`;
      const replay = await frames(await st.get(path, headers));
      expect(replay[0]?.event.type).toBe('node');
      expect(replay[0]?.id).toBe(spawnedAt);
      const first = replay[0]?.event;
      expect(first?.type === 'node' && first.node.nodeId).toBe(SUB);
      expect(first?.type === 'node' && first.node.status).toBe('running');
      expect(replay.at(-1)?.event.type).toBe('end');
    }
  }, 60_000);

  it('export is the agents slice of the journal as jsonl, DLP-masked: the planted secret is gone', async () => {
    const st = await stand();
    writeGolden(st);
    // Секрет лёг на диск мимо маски — проверка, что он правда есть в журнале.
    const raw = readFileSync(
      join(st.core.registry.tasksDir, st.ids.taskId, 'journal.jsonl'),
      'utf8',
    );
    expect(raw).toContain(VENDOR_KEY);
    const res = await st.get(`/v1/tasks/${st.ids.taskId}/agents/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const text = await res.text();
    expect(text).not.toContain(VENDOR_KEY);
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; data: unknown });
    expect(lines.every((l) => (AGENT_SLICE_KINDS as readonly string[]).includes(l.kind))).toBe(
      true,
    );
    expect(lines.some((l) => l.kind === 'agent.spawned')).toBe(true);
    expect(lines.some((l) => l.kind === 'unit.created')).toBe(false);
    const title = (lines.find((l) => l.kind === 'task.created')?.data as { title: string }).title;
    expect(title.startsWith('deploy with ')).toBe(true);
  }, 60_000);
});
