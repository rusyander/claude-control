import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteEndpoint, RouteLease } from '@agentdeck/contracts/core/routes';
import { afterAll, describe, expect, it } from 'vitest';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { bindLoopback } from '../platform/ports.ts';

/**
 * Маршруты и остановка ядра (P10, W2-A pass 2): сервер модели маршрута-заглушки — свой процесс.
 * Чистая остановка ядра (`core.stop()`) гасит его через `shutdown` маршрута из реестра; крах
 * ядра (SIGKILL / TerminateProcess) — нет, сервер остаётся для следующего ядра. Ядро здесь
 * настоящее: `bootCore` в отдельном процессе, не подставной объект.
 */

const BOOTED = fileURLToPath(new URL('./__fixtures__/boot-with-route.ts', import.meta.url));

const seenPids: number[] = [];
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterAll(() => {
  // Сервер-заглушка не переживает файл тестов, что бы ни случилось в тесте.
  for (const pid of seenPids) if (alive(pid)) process.kill(pid);
});

interface Booted {
  core: ChildProcessWithoutNullStreams;
  home: string;
  serverPid: number;
  endpoint: RouteEndpoint;
  output: () => string;
}

async function bootWithLease(): Promise<Booted> {
  const home = join(tempDir('boot-route-'), 'core');
  const core = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BOOTED, home],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  let seen = '';
  let errors = '';
  core.stderr.on('data', (chunk) => (errors += chunk));
  const line = await new Promise<string>((done, fail) => {
    core.stdout.on('data', (chunk) => {
      seen += chunk;
      const found = /^LEASE (.*)$/m.exec(seen);
      if (found?.[1]) done(found[1]);
    });
    core.on('exit', (code) => fail(new Error(`core exited ${code} before its lease: ${errors}`)));
  });
  const { lease, endpoint } = JSON.parse(line) as { lease: RouteLease; endpoint: RouteEndpoint };
  const ref = lease.resources.find((r) => r.kind === 'stub-server')?.ref ?? '';
  const serverPid = Number(new URL(ref).searchParams.get('pid'));
  // pid — в уборку сразу: упавшая проверка ниже не оставит сервер жить.
  seenPids.push(serverPid);
  return { core, home, serverPid, endpoint, output: () => seen };
}

async function answers(endpoint: RouteEndpoint): Promise<boolean> {
  try {
    const reply = await fetch(`${endpoint.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    return JSON.stringify(await reply.json()).includes('served by the booted core');
  } catch {
    return false;
  }
}

async function portFree(endpoint: RouteEndpoint): Promise<boolean> {
  try {
    const probe = await bindLoopback(Number(new URL(endpoint.baseUrl).port));
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

describe('core stop and route servers', () => {
  it('P10 clean core stop shuts every route server down: pid gone, port free, the release in the core log', async () => {
    const booted = await bootWithLease();
    expect(alive(booted.serverPid)).toBe(true);
    expect(await answers(booted.endpoint)).toBe(true);
    const exited = once(booted.core, 'exit');
    booted.core.stdin.write('stop\n');
    const [code] = (await exited) as [number | null];
    expect(code).toBe(0);
    expect(booted.output()).toContain('STOPPED');
    expect(alive(booted.serverPid)).toBe(false);
    expect(await portFree(booted.endpoint)).toBe(true);
    const log = readFileSync(join(booted.home, 'logs', 'core.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((text) => JSON.parse(text) as { event: string; [k: string]: unknown });
    expect(log.filter((e) => e.event === 'route.released')).toEqual([
      expect.objectContaining({ route: expect.any(String), fact: expect.stringMatching(/free/) }),
    ]);
    expect(log.find((e) => e.event === 'routes.stopped')).toMatchObject({ released: 1, leaks: 0 });
  }, 90_000);

  it('P10 a crashed core leaves the route server alive for the next core', async () => {
    const booted = await bootWithLease();
    const exited = once(booted.core, 'exit');
    // Смерть ядра без уборки: SIGKILL на POSIX, TerminateProcess на Windows.
    booted.core.kill('SIGKILL');
    await exited;
    expect(alive(booted.serverPid)).toBe(true);
    expect(await answers(booted.endpoint)).toBe(true);
    process.kill(booted.serverPid);
  }, 90_000);
});
