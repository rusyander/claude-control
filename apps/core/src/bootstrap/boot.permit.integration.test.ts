import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import type { AdapterEvent } from '../adapters/index.ts';
import { liveRoot, type LiveRoot } from '../adapters/conformance/__fixtures__/live.ts';
import {
  fixturePath,
  installReplay,
  readDump,
} from '../adapters/conformance/__fixtures__/replay.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../journal/resume.ts';
import { roadStart, roadTask } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Дорога права на НАСТОЯЩЕЙ загрузке ядра (`bootCore`, порт, токены сессий из ключа ядра):
 * запущенная переходником сессия прикрепляется к рантайму сессий, и
 * - вопрос сервера права (`POST /v1/session/permit`) решается кодеком ЭТОГО переходника — 200 с
 *   решением, а не 503; неприкреплённая и уже снятая сессия — 503 (fail-closed);
 * - вопрос строкой протокола (`permit.request`) ядро решает само и отвечает CLI его формой.
 * CLI — подставной: проигрывает запись живого CLI в ответ на настоящий stdin переходника.
 */

const A = '11111111-1111-4111-8111-111111111111';

const cores: BootedCore[] = [];
const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const stop of stops) await stop().catch(() => undefined);
  for (const core of cores) await core.stop();
});

interface Stand {
  core: BootedCore;
  live: LiveRoot;
  bin: string;
}

async function stand(command: string): Promise<Stand> {
  const core = await bootCore({
    home: join(tempDir('boot-permit-'), 'core'),
    build: 'permit-test',
  });
  cores.push(core);
  const live = liveRoot('boot-permit-');
  const bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(bin, command);
  return { core, live, bin };
}

async function permit(core: BootedCore, token: string, raw: unknown) {
  const res = await fetch(`${core.url}/v1/session/permit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function until<T>(probe: () => T | undefined, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const permitDecisions = (task: LiveTask, sessionId: string) =>
  readJournalLines(task.dir, task.taskId)
    .lines.filter(
      (l) =>
        l.kind === 'decision' &&
        l.sessionId === sessionId &&
        (l.data as { class: string }).class === 'permit',
    )
    .map((l) => (l.data as unknown as { output: { allow: boolean } }).output);

describe('core boot: the permission road of a live session', () => {
  it('the default registry carries a CLI-login route per adapter; the permit tool question of an attached session is decided, not 503', async () => {
    const s = await stand(claudeRunFacts.binary.command);
    const { core } = s;
    expect(core.routes.list().map((r) => r.id)).toEqual(
      core.adapters.ids().map((id) => `cli-login:${id}`),
    );
    // Запись живого CLI до ответа инструмента: модель запросила Bash и ждёт — вопрос законен.
    const full = readFileSync(fixturePath(claudeRunFacts.id, 'permit'), 'utf8').split('\n');
    const cut = full.findIndex((l) => l.includes('"tool_result"'));
    const fixture = join(s.live.root, 'permit-pending.jsonl');
    writeFileSync(fixture, `${full.slice(0, cut).join('\n')}\n`);
    // Сессия идёт ДОРОГОЙ ядра (как в продукте): совместимость, токен, хук, запуск, журнал.
    const task = await roadTask(core, claudeRunFacts.id);
    const prepared = await core.road.prepare(
      roadStart({
        live: s.live,
        bin: s.bin,
        task,
        adapterId: claudeRunFacts.id,
        fixture,
        dump: join(s.live.root, 'dump.json'),
      }),
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    const p = prepared.prepared;
    const { adapter, token } = p;
    const sessionId = p.spec.sessionId;
    const launched = await core.road.launch(p);
    if (!launched.ok) throw new Error(launched.reason);
    const handle = launched.handle;
    stops.push(() => adapter.stop(handle, 'tree'));
    core.road.started(p, handle, launched.layer);
    const raw = {
      tool_name: 'Bash',
      input: { command: 'node -v' },
      tool_use_id: 'toolu_stub_1_0',
    };

    // До прикрепления сессии кодека нет: отказ, а не разрешение.
    expect((await permit(core, token, raw)).status).toBe(503);

    const seen: AdapterEvent[] = [];
    const attached = core.road.attach({
      task,
      sessionId,
      adapter,
      handle,
      context: p.context,
      cwd: p.spec.cwd,
      onEvent: (e) => seen.push(e),
    });
    expect(core.sessions.size()).toBe(1);
    await adapter.send(handle, 'RUN_BASH now', A);
    await until(() => seen.find((e) => e.type === 'tool.requested'));

    const answered = await permit(core, token, raw);
    expect(answered.status).toBe(200);
    expect(answered.body.outcome).toBe('decided');
    const decisions = permitDecisions(task, sessionId);
    expect(decisions).toHaveLength(1);
    // Вопрос сопоставлен правилом ЭТОГО переходника: команда оболочки, а не «прочее».
    expect(decisions[0]).toMatchObject({ action: 'exec', tool: 'Bash' });
    // Само решение: `node -v` в копии ничем не запрещён — разрешение (F-79: раньше сверялся
    // только ответ с журналом, и ворота «всегда отказ» оставались зелёными).
    expect(decisions[0]!.allow).toBe(true);
    // Ответ — в форме кодека Claude (сервер права), с решением журнала.
    expect(answered.body.reply).toMatchObject({ behavior: 'allow' });

    attached.detach();
    expect(core.sessions.size()).toBe(0);
    expect((await permit(core, token, raw)).status).toBe(503);
    await adapter.stop(handle, 'tree');
    await attached.done;
  }, 90_000);

  // Решение ядра, а не запись CLI: тот же вопрос (`node -e …`) разрешён пустым запретом и
  // запрещён запретом `node` — ворота «всегда да» и «всегда нет» краснеют (F-79).
  it.each([
    ['permit-core-allow', [['git', 'push']], true],
    ['permit-core-deny', [['git', 'push'], ['node']], false],
  ] as const)(
    'the in-band permission question (permit.request) is decided by the core and answered to the CLI in its shape (%s)',
    async (recording, denyCommands, allow) => {
      const s = await stand(qwenRunFacts.binary.command);
      const { core } = s;
      const dump = join(s.live.root, 'dump.json');
      // Дорогой ядра: хук ядра, сервер права и оверлей запретов — те, что получил бы продукт.
      const task = await roadTask(core, qwenRunFacts.id);
      const prepared = await core.road.prepare(
        roadStart({
          live: s.live,
          bin: s.bin,
          task,
          adapterId: qwenRunFacts.id,
          fixture: fixturePath(qwenRunFacts.id, recording),
          dump,
          denyCommands: denyCommands.map((c) => [...c]),
        }),
      );
      if (!prepared.ok) throw new Error(prepared.reason);
      const p = prepared.prepared;
      const { adapter } = p;
      const sessionId = p.spec.sessionId;
      const launched = await core.road.launch(p);
      if (!launched.ok) throw new Error(launched.reason);
      const handle = launched.handle;
      stops.push(() => adapter.stop(handle, 'tree'));
      core.road.started(p, handle, launched.layer);
      const seen: AdapterEvent[] = [];
      const attached = core.road.attach({
        task,
        sessionId,
        adapter,
        handle,
        context: p.context,
        cwd: p.spec.cwd,
        onEvent: (e) => seen.push(e),
      });
      await adapter.send(handle, 'RUN_SHELL now', A);
      const ask = await until(() => seen.find((e) => e.type === 'permit.request'));
      await until(() => seen.find((e) => e.type === 'turn.ended'));
      const decisions = permitDecisions(task, sessionId);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.allow).toBe(allow);
      const reply = readDump(dump)!.stdin.find((l) => l.type === 'control_response') as {
        response: { request_id: string; response: { behavior: string } };
      };
      expect(reply.response).toMatchObject({
        request_id: ask.type === 'permit.request' ? ask.requestId : '',
        response: { behavior: allow ? 'allow' : 'deny' },
      });
      await adapter.stop(handle, 'soft');
      await attached.done;
      expect(core.sessions.size()).toBe(0);
    },
    90_000,
  );

  it('a malformed routes section in the core config refuses the boot and names the field', async () => {
    const home = join(tempDir('boot-permit-cfg-'), 'core');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ routes: { localOwn: { models: [] } } }),
    );
    await expect(bootCore({ home, build: 'permit-test' })).rejects.toThrow(
      /routes: localOwn\.server: .*; localOwn\.models: /,
    );
  });

  it('stub and local:own routes from the routes section join the CLI-login routes', async () => {
    const home = join(tempDir('boot-permit-cfg-'), 'core');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        routes: {
          stub: [{ name: 'e2e', script: ['hi'] }],
          localOwn: {
            server: { command: 'llama-server' },
            models: [{ id: 'm', path: join(home, 'm.gguf'), sizeBytes: 1 }],
          },
        },
      }),
    );
    const core = await bootCore({ home, build: 'permit-test' });
    cores.push(core);
    const ids = core.routes.list().map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'stub:e2e',
        'local:own',
        ...core.adapters.ids().map((id) => `cli-login:${id}`),
      ]),
    );
    expect(ids).toHaveLength(core.adapters.ids().length + 2);
  });
});
