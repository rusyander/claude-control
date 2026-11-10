import { describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../../adapters/index.ts';
import type { StepCtx } from '../../conductor/run/run.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { RoadAttach, RoadStart, SessionEnd } from '../session-road.ts';
import { roadSessionPort, type RoadPortDeps } from './loop.ts';

/**
 * Порт сессии исполнителя на дороге ядра: подделана только сама дорога (запуск и прикрепление
 * настоящего CLI проверяет сквозной прогон P10 через `conduct.ts`). Здесь — перевод событий
 * переходника в события цикла и снятие того, что порт держит.
 */

const STEP = { stepId: 'step-1' } as StepCtx;
const START = { adapterId: 'stub', cwd: '/copy' } as RoadStart;

function road(resumedId?: string) {
  const calls: string[] = [];
  let emit: (e: AdapterEvent) => void = () => undefined;
  let finish: () => void = () => undefined;
  const handle = (id: string) => ({ sessionId: id }) as SessionHandle;
  const deps: RoadPortDeps = {
    // Настоящая задача даёт подписку на журнал (порт слушает потерю хоста сеанса): здесь строк нет.
    task: { subscribe: () => () => undefined } as unknown as LiveTask,
    road: {
      prepare: async () => ({ ok: true, prepared: {} as never }),
      launch: async () => ({ ok: true, handle: handle('new'), layer: {} as never }),
      started: () => void calls.push('started'),
      contextFor: () => ({}) as never,
      attach: (input: RoadAttach) => {
        calls.push(`attach:${input.sessionId}:${input.resumed === true}`);
        emit = input.onEvent!;
        return {
          done: new Promise<void>((r) => (finish = r)),
          detach: () => undefined,
          end: async (mode) => {
            calls.push(`end:${input.sessionId}:${mode}`);
            return { stop: { how: mode }, found: [], unread: [] } as unknown as SessionEnd;
          },
        };
      },
    },
    adapterOf: () =>
      ({
        send: async (_h: SessionHandle, _t: string, cmdId: string, origin?: string) => {
          calls.push(`send:${cmdId}:${origin}`);
          return { dup: false };
        },
      }) as unknown as CliAdapter,
    startOf: () => START,
    ...(resumedId ? { resumeOf: () => ({ handle: handle(resumedId), replayed: 3 }) } : {}),
    note: () => undefined,
  };
  return { deps, calls, emit: (e: AdapterEvent) => emit(e), finish: () => finish() };
}

describe('roadSessionPort (zone B session port over the core road)', () => {
  it('maps adapter events: tool open/close counted once per toolUseId, turn end, stream end', async () => {
    const r = road();
    const port = roadSessionPort(r.deps);
    const seen: string[] = [];
    const got = await port.open(STEP, [], {
      turnEnded: () => seen.push('turn'),
      tool: (d) => seen.push(`tool${d}`),
      ended: () => seen.push('ended'),
    });
    expect(got).toEqual({ ok: true, sessionId: 'new', resumed: false });
    const tool = { toolUseId: 't1', cliInitiated: false };
    r.emit({ type: 'tool.requested', name: 'Bash', input: {}, ...tool });
    r.emit({ type: 'tool.requested', name: 'Bash', input: {}, ...tool });
    r.emit({ type: 'tool.result', isError: false, ...tool });
    r.emit({ type: 'tool.result', isError: false, ...tool });
    r.emit({
      type: 'turn.ended',
      attribution: 'a',
      origin: 'user' as never,
      isError: false,
      numTurns: 1,
      text: '',
    });
    r.finish();
    await new Promise((res) => setImmediate(res));
    expect(seen).toEqual(['tool1', 'tool-1', 'turn', 'ended']);
    expect(r.calls).toEqual(['started', 'attach:new:false']);
  });

  it('stage 12: an error turn end reports turnError before turnEnded; loginLost only when the adapter names the text', async () => {
    const r = road();
    const base = r.deps.adapterOf;
    r.deps.adapterOf = (...a: Parameters<typeof base>) =>
      ({
        ...base(...a),
        loginLost: (text: string) => text.endsWith('Please run /login'),
      }) as CliAdapter;
    const port = roadSessionPort(r.deps);
    const seen: string[] = [];
    await port.open(STEP, [], {
      turnEnded: () => seen.push('turn'),
      tool: () => undefined,
      ended: () => undefined,
      turnError: (t) => seen.push(`error:${t}`),
      loginLost: (t) => seen.push(`login:${t}`),
    });
    const end = (isError: boolean, text: string) =>
      r.emit({
        type: 'turn.ended',
        attribution: 'a',
        origin: 'user' as never,
        isError,
        numTurns: 1,
        text,
      });
    end(true, 'Not logged in · Please run /login');
    end(true, "You've hit your limit");
    end(false, 'Please run /login');
    expect(seen).toEqual([
      'error:Not logged in · Please run /login',
      'login:Not logged in · Please run /login',
      'turn',
      "error:You've hit your limit",
      'turn',
      'turn',
    ]);
  });

  it('G9 a new session is measured right after it is journaled; a resumed one is not', async () => {
    const r = road();
    const fresh = roadSessionPort({
      ...r.deps,
      measureBase: () => r.calls.push('measure') > 0,
    });
    const on = { turnEnded: () => undefined, tool: () => undefined, ended: () => undefined };
    await fresh.open(STEP, [], on);
    expect(r.calls).toEqual(['started', 'measure', 'attach:new:false']);
    const again = road('old');
    const resumed = roadSessionPort({
      ...again.deps,
      measureBase: () => again.calls.push('measure') > 0,
    });
    await resumed.open(STEP, [], on);
    expect(again.calls).toEqual(['attach:old:true']);
  });

  it('a resumed session is attached, not launched; release ends what is still open, once', async () => {
    const r = road('old');
    const port = roadSessionPort(r.deps);
    const on = { turnEnded: () => undefined, tool: () => undefined, ended: () => undefined };
    expect(await port.open(STEP, [], on)).toEqual({ ok: true, sessionId: 'old', resumed: true });
    // Источник текста доходит до переходника (Q8): без указания — платформа, слово человека — human.
    await port.send('old', 'brief', 'step-1');
    await port.send('old', 'answer', 'cmd-2', 'human');
    await port.release();
    await port.release();
    await port.end('old', 'tree');
    expect(r.calls).toEqual([
      'attach:old:true',
      'send:step-1:platform',
      'send:cmd-2:human',
      'end:old:soft',
    ]);
    expect(port.ends.get('old')).toMatchObject({ stop: { how: 'soft' } });
  });

  it('a resumed session already held (attached while its step was checking) is rebound, not attached twice', async () => {
    const r = road('old');
    const port = roadSessionPort(r.deps);
    const seen: string[] = [];
    const quiet = {
      turnEnded: () => seen.push('quiet'),
      tool: () => undefined,
      ended: () => undefined,
    };
    const owner = {
      turnEnded: () => seen.push('owner'),
      tool: () => undefined,
      ended: () => undefined,
    };
    await port.open(STEP, [], quiet);
    expect(await port.open(STEP, [], owner)).toEqual({ ok: true, sessionId: 'old', resumed: true });
    r.emit({
      type: 'turn.ended',
      attribution: 'a',
      origin: 'user' as never,
      isError: false,
      numTurns: 1,
      text: '',
    });
    expect(seen).toEqual(['owner']);
    expect(r.calls).toEqual(['attach:old:true']);
  });

  it('journal refuses session.started after launch: the process tree is stopped, the step gets a refusal', async () => {
    const r = road();
    const stops: string[] = [];
    r.deps.road.started = () => {
      throw new Error('modelAsked rejected');
    };
    r.deps.adapterOf = () =>
      ({
        stop: async (h: SessionHandle, mode: string) => void stops.push(`${h.sessionId}:${mode}`),
      }) as unknown as CliAdapter;
    const port = roadSessionPort(r.deps);
    const on = { turnEnded: () => undefined, tool: () => undefined, ended: () => undefined };
    const got = await port.open(STEP, [], on);
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.reason).toMatch(/^session not journaled: .*modelAsked rejected/);
    expect(stops).toEqual(['new:tree']);
    expect(r.calls).toEqual([]);
  });
});
