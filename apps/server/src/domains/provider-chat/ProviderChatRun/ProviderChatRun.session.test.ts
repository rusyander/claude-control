import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderChatMessage } from '@agentdeck/contracts';
import { getProvider } from '../../../providers/registry.ts';
import { ProviderChatRun, type ProviderChatRunEvent } from './ProviderChatRun.ts';
import type { LiveTurn, LiveTurnOptions, LiveTurnResult } from '../live/types.ts';
import { digestPreamble, type LiveSessionPrevious } from '../live-session/live-session.ts';

/**
 * @covers ProviderChatRun.ts — `liveSessionRequest`, `done.liveSession` (E2b)
 * @scenario прогон решает, продолжать ли сессию CLI: продолженной уходят только
 *   блоки хода и реплики после увиденных; смена системного указания или каталога
 *   скиллов, чужой CLI, устаревшая отметка — новая сессия с полным промптом.
 *
 * Подменён ход целиком (что он делает с сессией, проверяет `live/live-sessions.test.ts`).
 */

class SessionTurn implements LiveTurn {
  seen?: LiveTurnOptions;
  private readonly result: LiveTurnResult;
  constructor(result: LiveTurnResult) {
    this.result = result;
  }
  run(
    options: LiveTurnOptions,
    _onDelta: (text: string) => void,
    onSteerable?: () => void,
  ): Promise<LiveTurnResult> {
    this.seen = options;
    onSteerable?.();
    return Promise.resolve(this.result);
  }
  steer(): Promise<boolean> {
    return Promise.resolve(false);
  }
  stop(): void {}
}

const at = '2026-01-01T00:00:00.000Z';
const HISTORY: ProviderChatMessage[] = [
  { id: 'm1', role: 'user', content: 'Первый вопрос', at },
  { id: 'm2', role: 'assistant', content: 'Первый ответ', at },
  { id: 'm3', role: 'user', content: 'Второй вопрос', at },
];
const SYSTEM = 'Системное указание разговора';
const SKILLS = {
  entries: [{ name: 'deploy', description: 'выкатка', priority: 1 }],
  budgetChars: 2_000,
  readBody: () => ({ text: 'тело', filePath: '/skills/deploy/SKILL.md' }),
};

describe('ProviderChatRun: сессия CLI между ходами', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-session-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function start(
    extra: Record<string, unknown>,
    result: LiveTurnResult = { kind: 'done', reply: 'ответ', session: 'thr-9', resumed: true },
    history: ProviderChatMessage[] = HISTORY,
  ) {
    const turn = new SessionTurn(result);
    const events: ProviderChatRunEvent[] = [];
    const inputs: string[] = [];
    await new ProviderChatRun().start(
      {
        provider: getProvider('codex'),
        history,
        chatId: 'chat',
        appDataDir: dir,
        detect: () => true,
        liveTurn: () => turn,
        systemPrefix: SYSTEM,
        onInput: (text: string) => inputs.push(text),
        ...extra,
      } as Parameters<ProviderChatRun['start']>[0],
      (event) => events.push(event),
    );
    return { seen: turn.seen, done: events.at(-1), input: inputs.at(-1), inputs };
  }

  const previous = (patch: Partial<LiveSessionPrevious> = {}): LiveSessionPrevious => ({
    kind: 'codex-app-server',
    id: 'thr-1',
    covered: 2,
    preamble: digestPreamble([SYSTEM]),
    ...patch,
  });

  it('без liveSession сессия одноразовая: поля нет ни в ходе, ни в done', async () => {
    const { seen, done } = await start({});
    expect(seen?.session).toBeUndefined();
    expect(done).toEqual({ type: 'done', reply: 'ответ', transport: 'live' });
  });

  it('первый ход держит сессию и отдаёт её с отпечатком постоянной части', async () => {
    const { seen, done } = await start({ liveSession: {} });
    expect(seen?.session).toEqual({});
    expect(done).toEqual({
      type: 'done',
      reply: 'ответ',
      transport: 'live',
      liveSession: { kind: 'codex-app-server', id: 'thr-9', preamble: digestPreamble([SYSTEM]) },
    });
  });

  it('продолженной сессии уходят только реплики после увиденных', async () => {
    const { seen } = await start({ liveSession: { previous: previous() } });
    expect(seen?.session).toEqual({ resume: { id: 'thr-1', prompt: 'Второй вопрос' } });
    // Полный промпт остаётся — на случай, если CLI сессию не поднимет.
    expect(seen?.prompt).toContain(SYSTEM);
    expect(seen?.prompt).toContain('Первый вопрос');
  });

  it('тело названного скилла идёт и в продолженную сессию, каталог — нет', async () => {
    const history: ProviderChatMessage[] = [
      ...HISTORY.slice(0, 2),
      { id: 'm3', role: 'user', content: 'сделай /deploy', at },
    ];
    const catalog = 'Available skills (name: purpose). Name a skill to get its instructions:';
    const { seen } = await start(
      { skills: SKILLS, liveSession: { previous: previous({ preamble: undefined }) } },
      undefined,
      history,
    );
    // Отметка без отпечатка — только удалить.
    expect(seen?.session).toEqual({ discard: 'thr-1' });

    const preamble = digestPreamble([SYSTEM, `${catalog}\n- deploy: выкатка`]);
    const resumed = await start(
      { skills: SKILLS, liveSession: { previous: previous({ preamble }) } },
      undefined,
      history,
    );
    expect(resumed.seen?.session).toEqual({
      resume: {
        id: 'thr-1',
        prompt:
          'The instructions of the skill "deploy" are in a file, read it in full: /skills/deploy/SKILL.md\n\nсделай /deploy',
      },
    });
  });

  it('другое системное указание — новая сессия, прежняя удаляется', async () => {
    const { seen } = await start({
      systemPrefix: 'Другое указание',
      liveSession: { previous: previous() },
    });
    expect(seen?.session).toEqual({ discard: 'thr-1' });
  });

  it('сессия другого CLI не продолжается и не удаляется этим', async () => {
    const { seen } = await start({ liveSession: { previous: previous({ kind: 'qwen-serve' }) } });
    expect(seen?.session).toEqual({});
  });

  it('устаревшая отметка (без covered) — только удалить', async () => {
    const { seen } = await start({
      liveSession: { previous: previous({ covered: undefined }) },
    });
    expect(seen?.session).toEqual({ discard: 'thr-1' });
  });

  it('новой реплики человека после увиденного нет — продолжать нечем', async () => {
    const { seen } = await start({ liveSession: { previous: previous({ covered: 3 }) } });
    expect(seen?.session).toEqual({ discard: 'thr-1' });
  });

  /**
   * «Что получил агент» (TQ-09, 12.10.2026): запись была последней репликой, а
   * ход получал указание панели, блоки навыков и хуков и всю переписку. Вход —
   * ровно то, что ушло CLI: новой сессии весь промпт, продолженной — её хвост.
   */
  it('вход хода — ровно то, что ушло CLI: новой сессии весь промпт, продолженной — хвост (TQ-09)', async () => {
    const fresh = await start({ liveSession: {} });
    expect(fresh.input).toBe(fresh.seen?.prompt);
    expect(fresh.input).toContain(SYSTEM);
    expect(fresh.input).toContain('Первый вопрос');

    const resumed = await start({ liveSession: { previous: previous() } });
    // И посреди хода тоже: первая запись — уже хвост, а не полный промпт.
    expect(resumed.inputs).toEqual(['Второй вопрос']);
  });

  it('CLI не поднял сессию — во входе полный промпт, с которым он открыл новую (TQ-09)', async () => {
    const { seen, input } = await start(
      { liveSession: { previous: previous() } },
      { kind: 'done', reply: 'ответ', session: 'thr-9', resumed: false },
    );
    expect(input).toBe(seen?.prompt);
    expect(input).toContain(SYSTEM);
  });

  it('ход без session в ответе — done без liveSession', async () => {
    const { done } = await start({ liveSession: {} }, { kind: 'done', reply: 'ответ' });
    expect(done).toEqual({ type: 'done', reply: 'ответ', transport: 'live' });
  });
});
