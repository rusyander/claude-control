import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import { stopSession } from '../adapters/launcher/session-io.ts';
import { liveRoot, livePin } from '../adapters/conformance/__fixtures__/live.ts';
import {
  fixturePath,
  installReplay,
  readDump,
  replayEnv,
} from '../adapters/conformance/__fixtures__/replay.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { bootCore, type BootedCore, type BootOptions } from './boot.ts';
import { sessionDirOf } from './conductor-wiring/session-start.ts';

/**
 * Набор панели вопросу чужого CLI (этап 10, G13) на НАСТОЯЩЕЙ загрузке ядра: `POST /v1/ask` с
 * `fields.session` (дописка + имена) и значениями `env` вне полей → задача `ask@1` → дорога ядра
 * запускает переходник Qwen Code (записанный CLI `replay-cli.mjs` под именем `qwen`): дом набора
 * `QWEN_HOME` — в окружении процесса, дописка — в его `--append-system-prompt`. Прежнее окно
 * помощника давало чужому CLI ровно это окружение (`route.kit.env`, HEAD `assistant-route.ts`).
 * Значение в журнал не ложится — только имя.
 */

const cores: BootedCore[] = [];
const sessionDirs: string[] = [];
// 60 с: под нагрузкой общего прогона остановка ядер и деревьев сеансов не укладывалась в 20 с
// по умолчанию (в одиночку весь файл — 14 с); зависание остановки по-прежнему ловится.
afterAll(async () => {
  for (const core of cores) await core.stop().catch(() => undefined);
  for (const dir of sessionDirs) await stopSession(dir, 'tree').catch(() => undefined);
}, 60_000);

async function until<T>(probe: () => T | undefined, what: () => string, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${what()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const lines = (t: LiveTask): JournalLine[] => readJournalLines(t.dir, t.taskId).lines;

const tailOf = (task: LiveTask) => (): string =>
  lines(task)
    .slice(-14)
    .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 260)}`)
    .join('\n');

async function ask(
  core: BootedCore,
  fields: Record<string, unknown>,
  env?: Record<string, string>,
): Promise<{ status: number; reply: { taskId?: string; problems?: string[] } }> {
  const coreToken = readFileSync(core.layout.token, 'utf8').trim();
  const auth = { authorization: `Bearer ${coreToken}` };
  const page = newId();
  const minted = await fetch(`${core.url}/v1/nonce?page=${page}`, { headers: auth });
  const { nonce } = (await minted.json()) as { nonce: string };
  const res = await fetch(`${core.url}/v1/ask`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      cmdId: newId(),
      fields,
      proof: { nonce, page },
      ...(env ? { env } : {}),
    }),
  });
  return { status: res.status, reply: (await res.json()) as { taskId?: string } };
}

const loginPath: BootOptions['loginPath'] = async () => ({
  path: process.env.PATH ?? '',
  source: 'known-dirs',
  reason: 'test login path',
});

const KIT_MARK = 'AGENTDECK-KIT-RULES-G13';

describe('core ask carries the panel kit to a foreign CLI (stage 10 G13)', () => {
  it('replayed qwen: session.env QWEN_HOME reaches the CLI process env, session.append its --append-system-prompt; the journal holds the name, not the value; values without names → 422, no task', async () => {
    const home = join(tempDir('ask-kit-'), 'core');
    const live = liveRoot('ask-kit-');
    const bin = join(live.root, 'bin');
    mkdirSync(bin, { recursive: true });
    installReplay(bin, qwenRunFacts.binary.command);
    const dump = join(live.root, 'dump.json');
    const kitHome = join(live.root, 'kit', 'qwen-home');
    mkdirSync(kitHome, { recursive: true });
    const trace = join(live.root, 'stub-trace.jsonl');
    const core = await bootCore({
      home,
      build: 'ask-kit',
      loginPath,
      routeConfig: { stub: [{ name: 'ask', script: ['ok'], trace }] },
      loop: {
        pin: () => ({
          ...livePin(live, replayEnv({ fixture: fixturePath('qwen', 'basic'), dump })),
          REPLAY_MAX_MS: '150000',
        }),
        pathPrefix: [bin, dirname(process.execPath)],
        sweepMs: 100,
      },
    });
    cores.push(core);

    const before = core.registry.list().length;
    const orphan = await ask(
      core,
      { title: 'без имён', prompt: 'ok?', tools: 'none' },
      { QWEN_HOME: kitHome },
    );
    expect(orphan.status).toBe(422);
    expect(JSON.stringify(orphan.reply)).toContain('env: values without fields.session.env names');
    expect(core.registry.list().length).toBe(before);

    const { status, reply } = await ask(
      core,
      {
        title: 'помощник формы',
        prompt: 'Предложи имя правила.',
        tools: 'none',
        adapter: qwenRunFacts.id,
        routes: [
          { adapter: qwenRunFacts.id, route: { kind: 'stub', id: 'stub:ask' }, modelPattern: '*' },
        ],
        model: 'stub-model',
        session: { append: KIT_MARK, env: ['QWEN_HOME'] },
      },
      { QWEN_HOME: kitHome },
    );
    expect(status, JSON.stringify(reply)).toBe(202);
    const task = core.registry.live(reply.taskId!)!;
    expect(task.state.created?.session).toEqual({ append: KIT_MARK, env: ['QWEN_HOME'] });

    const started = await until(
      () => lines(task).find((l) => l.kind === 'session.started'),
      tailOf(task),
    );
    sessionDirs.push(sessionDirOf(task, started.sessionId!));
    const got = await until(
      () => readDump(dump) ?? undefined,
      () => `qwen replay dump; ${tailOf(task)()}`,
    );
    expect(got.env.QWEN_HOME).toBe(kitHome);
    const appended = got.argv.find((a) => a.startsWith('--append-system-prompt='));
    expect(appended).toContain(KIT_MARK);
    // Значение — только в памяти ядра: в журнале задачи имя, а не путь дома набора.
    const created = lines(task).find((l) => l.kind === 'task.created');
    expect(JSON.stringify(created?.data)).toContain('QWEN_HOME');
    expect(JSON.stringify(created?.data)).not.toContain(kitHome.replace(/\\/g, '\\\\'));
  }, 240_000);
});
