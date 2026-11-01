import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HopRegisterReply, HopRegisterSpec } from '@agentdeck/contracts/core/hops';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { isReserved } from '../platform/ports.ts';
import { createLivenessProbe, identityOfPid } from '../platform/process-identity.ts';
import { hasValue } from '../platform/os-kind.ts';
import { ensureHopHost, hopStatus, registerTag, type HopHostHandle } from '../routes/hops/hops.ts';
import { anthropicBody, ask, tempDir } from './__fixtures__/hop-stand.ts';
import { HopHostBusy, startHopHost } from './host.ts';

/**
 * Хост звеньев переживает ядро (P123): подставное ядро — настоящий процесс, запускающий хост
 * клиентом ядра; его убивают посреди запроса сеанса, а запрос доходит. Перезапуск хоста
 * возвращает те же порты и те же метки, второго писателя расхода не бывает. Каждый случай
 * сам находит или поднимает хост — их можно гонять поодиночке (мутанты гонят один `-t`).
 */

const FAKE_CORE = fileURLToPath(
  new URL('../routes/hops/__fixtures__/fake-core.ts', import.meta.url),
);
const HOST_MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

const home = tempDir('hop-crash-');
let stub: StubModel | undefined;
const hostPids = new Set<number>();

beforeAll(async () => {
  stub = await startStubModel({
    script: {
      rules: [{ when: 'HOLD', step: { text: 'survived the core', holdMs: Infinity } }],
      fallback: 'plain answer',
    },
  });
});

afterAll(async () => {
  // Хост — отвязанный процесс: тест снимает его сам, по pid + старту, никогда голым номером.
  const probe = createLivenessProbe();
  for (const pid of hostPids) {
    const identity = await identityOfPid(pid);
    if (hasValue(identity) && (await probe.isAlive(identity.value, { fresh: true })) === 'alive')
      process.kill(pid);
  }
  await stub?.close();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function upstream(): string {
  if (!stub) throw new Error('stub not started');
  return stub.baseUrl;
}

async function liveHost(): Promise<HopHostHandle> {
  const handle = await ensureHopHost({ home, retryPauseMs: 10 });
  hostPids.add(handle.pid);
  return handle;
}

async function startFakeCore(
  spec: HopRegisterSpec,
): Promise<{ child: ChildProcess; handle: HopHostHandle; reply: HopRegisterReply }> {
  const arg = Buffer.from(JSON.stringify({ home, spec }), 'utf8').toString('base64url');
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', FAKE_CORE, arg],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let out = '';
  const line = await new Promise<string>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const found = /^HOP (.+)$/m.exec(out);
      if (found?.[1]) resolve(found[1]);
    });
    child.once('exit', (code) => reject(new Error(`fake core exited ${code}: ${out}`)));
  });
  const parsed = JSON.parse(line) as { handle: HopHostHandle; reply: HopRegisterReply };
  hostPids.add(parsed.handle.pid);
  return { child, ...parsed };
}

function spec(tag: string): HopRegisterSpec {
  return {
    tag,
    sessionId: `${tag}-session`,
    routeId: 'route-stub',
    upstream: upstream(),
    from: 'anthropic-messages',
    to: 'anthropic-messages',
    keyRef: null,
    dlp: { required: true, rulesHash: null },
    features: [],
  };
}

async function waitDead(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

describe('хост звеньев переживает ядро (P123)', () => {
  it('P123 ядро убито посреди запроса → запрос сеанса доходит; порты вне 5170-5180', async () => {
    const core = await startFakeCore(spec('crash-tag'));
    const status = await hopStatus(core.handle);
    for (const port of [new URL(core.handle.url).port, status.ports.dlp, status.ports.gateway])
      expect(isReserved(Number(port))).toBe(false);
    expect(core.reply.port).toBe(status.ports.dlp);

    const pending = ask(
      core.reply.port,
      core.reply.placeholder,
      'anthropic',
      anthropicBody('HOLD'),
    );
    const deadline = Date.now() + 10_000;
    while (!stub?.holding() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(stub?.holding()).toBe(true);

    core.child.kill();
    await once(core.child, 'exit');
    expect(alive(core.handle.pid)).toBe(true);
    stub?.release();
    const answer = await pending;
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('survived the core');
  });

  it('P123 второй писатель расхода не стартует: замок хоста держит живой хост', async () => {
    await liveHost();
    await expect(startHopHost({ home })).rejects.toBeInstanceOf(HopHostBusy);
    const second = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        HOST_MAIN,
        Buffer.from(JSON.stringify({ home }), 'utf8').toString('base64url'),
      ],
      { stdio: 'ignore' },
    );
    const [code] = (await once(second, 'exit')) as [number | null];
    expect(code).toBe(3);
  });

  it('P123 хост перезапущен → те же порты, метка сеанса жива без перерегистрации', async () => {
    const first = await liveHost();
    const reply = await registerTag(first, spec('restart-tag'));
    const before = await hopStatus(first);
    process.kill(first.pid);
    await waitDead(first.pid);
    expect(alive(first.pid)).toBe(false);

    const handle = await liveHost();
    expect(handle.launched).toBe(true);
    expect(handle.pid).not.toBe(first.pid);
    const after = await hopStatus(handle);
    expect(after.ports).toEqual(before.ports);
    expect(new URL(handle.url).port).toBe(new URL(first.url).port);
    expect(after.tags).toContain('restart-tag');

    // Окружение живого сеанса не менялось: та же заглушка на том же порту.
    const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('again'));
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('plain answer');
  });
});
