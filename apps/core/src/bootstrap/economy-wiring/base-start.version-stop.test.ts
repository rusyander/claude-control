import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliAdapter, SessionHandle } from '../../adapters/index.ts';
import { installReplay } from '../../adapters/conformance/__fixtures__/replay.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import type { ProbeTrace } from '../../context/base/index.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import type { Prepared } from '../session-road/road.types.ts';
import { baseAtStart, versionFromOutput } from './base-start.ts';
import { createContextWiring, probeOnStub } from './context.ts';

/**
 * Версия CLI в ключе замера базы и снятие проб при остановке ядра (G9). Версию отвечает
 * подставной `claude` на PATH пина сеанса (тот же поиск исполняемого, что у запуска сеанса);
 * проба базы — внешняя граница (CLI на заглушке), здесь подменена, кроме теста `probeOnStub`,
 * где настоящая заглушка модели на петле, а переходник — подставной.
 */

const BRIEF_MARK = 'AGENTDECK_BASE_PROBE x';
const TRACE: ProbeTrace = { bodies: [`${'s'.repeat(40_000)}${BRIEF_MARK}`], brief: BRIEF_MARK };
const BIND = { channel: { via: 'env' } as never, dialect: 'anthropic-messages' as const };

function prepared(sessionId: string, pin: Record<string, string> = {}): Prepared {
  return {
    adapter: { id: 'claude', versionCommand: 'claude' },
    start: { stepKind: 'work', sessionId },
    spec: {
      dir: tempDir('bsv-dir-'),
      cwd: tempDir('bsv-cwd-'),
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
}

/** Пин с каталогом подставного CLI первым в PATH. */
function pinWith(bin: string, extra: Record<string, string> = {}): Record<string, string> {
  const pin: Record<string, string> = { ...(process.env as Record<string, string>), ...extra };
  delete pin.Path;
  pin.PATH = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;
  return pin;
}

async function seeded() {
  const registry = createTaskRegistry(tempDir('bsv-tasks-'), deps());
  const task = await registry.create(CREATED);
  return { task, sessionId: seedSession(task, { stepKind: 'work' }).sessionId };
}

/** Замер идёт в фоне: ждать его исхода — строки замера или заметки «не замерено». */
async function settled(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i += 1) await new Promise((r) => setTimeout(r, 10));
}

const homeContext = () => createContextWiring({ homeRoot: join(tempDir('bsv-home-'), 'core') });

describe('base key carries the CLI version; core stop takes the probe down (G9)', () => {
  it('the key holds the version the CLI prints for --version; no readable version → not measured', async () => {
    expect(versionFromOutput('2.0.14 (Claude Code)\n')).toBe('2.0.14');
    expect(versionFromOutput('no digits here')).toBeNull();
    const bin = tempDir('bsv-bin-');
    installReplay(bin, 'claude');
    const context = homeContext();
    const notes: string[] = [];
    const note = (event: string, data: Record<string, unknown>) =>
      notes.push(`${event}:${String(data.reason)}`);

    const a = await seeded();
    const measure = baseAtStart({ context, note, probe: async () => TRACE });
    expect(measure(a.task, prepared(a.sessionId, pinWith(bin, { REPLAY_VERSION: '9.8.7' })))).toBe(
      true,
    );
    await settled(() => a.task.state.bases.length > 0 || notes.length > 0);
    expect(notes).toEqual([]);
    expect(a.task.state.bases).toHaveLength(1);
    expect(a.task.state.bases[0]!.cliVersion).toBe('9.8.7');

    // Та же установка (тот же PATH) — версия прочитана один раз на ядро, второй запуск не нужен.
    const a2 = await seeded();
    measure(a2.task, prepared(a2.sessionId, pinWith(bin, { REPLAY_VERSION: '1.1.1' })));
    await settled(() => a2.task.state.bases.length > 0 || notes.length > 0);
    expect(a2.task.state.bases[0]!.cliVersion).toBe('9.8.7');

    // Другая установка (свой PATH) — своя версия, свой ключ: замер прежней её не судит.
    const bin2 = tempDir('bsv-bin2-');
    installReplay(bin2, 'claude');
    const b = await seeded();
    measure(b.task, prepared(b.sessionId, pinWith(bin2, { REPLAY_VERSION: '9.9.0' })));
    await settled(() => b.task.state.bases.length > 0 || notes.length > 0);
    expect(b.task.state.bases[0]!.cliVersion).toBe('9.9.0');

    const c = await seeded();
    const empty = tempDir('bsv-nobin-');
    expect(measure(c.task, prepared(c.sessionId, { ...pinWith(empty), PATH: empty }))).toBe(true);
    await settled(() => notes.length > 0);
    expect(c.task.state.bases).toHaveLength(0);
    expect(notes).toEqual(['context.base.unmeasured:cli version unread']);

    // Нечитаемая версия не запоминается: та же установка, ответившая позже, — замерена.
    const bin3 = tempDir('bsv-bin3-');
    installReplay(bin3, 'claude');
    const d = await seeded();
    measure(d.task, prepared(d.sessionId, pinWith(bin3, { REPLAY_VERSION: 'garbage' })));
    await settled(() => notes.length > 1);
    expect(notes).toEqual([
      'context.base.unmeasured:cli version unread',
      'context.base.unmeasured:cli version unread',
    ]);
    const d2 = await seeded();
    measure(d2.task, prepared(d2.sessionId, pinWith(bin3, { REPLAY_VERSION: '4.4.4' })));
    await settled(() => d2.task.state.bases.length > 0 || notes.length > 2);
    await measure.stop();
    expect(notes).toHaveLength(2);
    expect(d2.task.state.bases[0]!.cliVersion).toBe('4.4.4');
  });

  it('stop while the version is still being read: the probe never starts', async () => {
    const { task, sessionId } = await seeded();
    const notes: string[] = [];
    let probes = 0;
    let answer: (v: string) => void = () => undefined;
    const measure = baseAtStart({
      context: homeContext(),
      note: (event, data) => notes.push(`${event}:${String(data.reason)}`),
      version: () => new Promise<string>((r) => (answer = r)),
      probe: async () => {
        probes += 1;
        return TRACE;
      },
    });
    expect(measure(task, prepared(sessionId))).toBe(true);
    const stopping = measure.stop();
    answer('1.0.0');
    await stopping;
    expect(probes).toBe(0);
    expect(task.state.bases).toHaveLength(0);
    expect(notes).toEqual(['context.base.unmeasured:core stopping']);
  });

  it('stop aborts a running probe and waits for it: nothing is journaled after, no new measure starts', async () => {
    const { task, sessionId } = await seeded();
    const notes: string[] = [];
    let started = false;
    const measure = baseAtStart({
      context: homeContext(),
      note: (event, data) => notes.push(`${event}:${String(data.reason)}`),
      version: async () => '1.0.0',
      probe: (_p, _key, signal) =>
        new Promise<ProbeTrace>((_, reject) => {
          started = true;
          signal.addEventListener('abort', () => reject(new Error('aborted by stop')), {
            once: true,
          });
        }),
    });
    expect(measure(task, prepared(sessionId))).toBe(true);
    for (let i = 0; i < 200 && !started; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(started).toBe(true);
    await measure.stop();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^context\.base\.unmeasured:.*aborted by stop/);
    expect(task.state.bases).toHaveLength(0);
    expect(measure(task, prepared(sessionId))).toBe(false);
  });

  it('probeOnStub on abort stops the probe CLI as a tree and rejects; an aborted signal never launches', async () => {
    const stops: string[] = [];
    let launches = 0;
    let release: () => void = () => undefined;
    const adapter = {
      id: 'claude',
      launch: async () => {
        launches += 1;
        return { ok: true, handle: { sessionId: 'p' }, layer: {} };
      },
      send: async () => ({ dup: false }),
      events: async function* () {
        await new Promise<void>((r) => (release = r));
        // Ход не кончается: поток пуст, пока пробу не снимут.
        yield* [];
      },
      stop: async (_h: SessionHandle, mode: string) => {
        stops.push(mode);
        release();
      },
    } as unknown as CliAdapter;
    const spec = prepared('p').spec;
    const abort = new AbortController();
    const run = probeOnStub(adapter, { ...spec, sessionId: 'p' }, BIND, 60_000, abort.signal);
    setTimeout(() => abort.abort(), 50);
    await expect(run).rejects.toThrow(/aborted \(core stopping\)/);
    expect(stops).toEqual(['tree']);
    await expect(
      probeOnStub(adapter, { ...spec, sessionId: 'q' }, BIND, 60_000, abort.signal),
    ).rejects.toThrow(/aborted before start/);
    expect(launches).toBe(1);
  });
});
