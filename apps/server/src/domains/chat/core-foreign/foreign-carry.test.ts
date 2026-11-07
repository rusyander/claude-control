import { describe, expect, it } from 'vitest';
import { coreWithTurns } from '../core-run/__fixtures__/core-with-turns.ts';
import { CoreChatRun } from '../core-run/core-run.ts';
import type { CoreChatBook, CoreChatEntry, CoreChatPort } from '../core-run/core-run.types.ts';
import { createForeignCarry, type ForeignCarryDeps, type KitExtras } from './foreign-carry.ts';

/**
 * Слой панели разговора чужого CLI через ядро (G6): строка о тестах и набор панели для CLI —
 * полями сеанса и значениями оценки. Набор Qwen — свой `QWEN_HOME` (значение — только в теле
 * оценки), набор Codex — правила текстом дописки; локальность — по маршруту шлюза локального слоя.
 */

const LOCAL_ROUTE = {
  adapter: 'qwen',
  route: { kind: 'gateway' as const, id: 'gateway:local-ollama' },
  modelPattern: '*',
};

function deps(kit: (input: Parameters<ForeignCarryDeps['kitExtras']>[0]) => KitExtras) {
  const seen: Array<Parameters<ForeignCarryDeps['kitExtras']>[0]> = [];
  return {
    seen,
    deps: {
      testsNote: (cwd: string) => (cwd === 'C:/proj' ? 'TESTS_LINE' : undefined),
      kitExtras: (input) => {
        seen.push(input);
        return kit(input);
      },
    } satisfies ForeignCarryDeps,
  };
}

describe('createForeignCarry', () => {
  it('qwen on the local gateway: the kit home rides env (value outside the fields), tests line is the append', () => {
    const d = deps(({ provider, local }): KitExtras =>
      provider === 'qwen' && local
        ? { args: [], env: { QWEN_HOME: 'C:/kit/qwen-home' } }
        : { args: [], env: {} },
    );
    const got = createForeignCarry(d.deps)({ cli: 'qwen', cwd: 'C:/proj', routes: [LOCAL_ROUTE] });
    expect(d.seen).toEqual([{ provider: 'qwen', local: true, hasSources: false }]);
    expect(got).toEqual({
      ok: true,
      carry: {
        session: { append: 'TESTS_LINE', env: ['AGENTDECK_TESTS_NOTE', 'QWEN_HOME'] },
        env: { AGENTDECK_TESTS_NOTE: '1', QWEN_HOME: 'C:/kit/qwen-home' },
      },
    });
  });

  it('codex: the kit rules follow the tests line in the append; no route → not local', () => {
    const d = deps(() => ({ args: [], env: {}, append: 'KIT_RULES' }));
    const got = createForeignCarry(d.deps)({ cli: 'codex', cwd: 'C:/proj' });
    expect(d.seen[0]).toMatchObject({ provider: 'codex', local: false });
    expect(got.ok && got.carry.session.append).toBe('TESTS_LINE\n\nKIT_RULES');
  });

  it('not a tests project and no kit — only the tests mark', () => {
    const d = deps(() => ({ args: [], env: {} }));
    expect(createForeignCarry(d.deps)({ cli: 'goose', cwd: 'C:/other' })).toEqual({
      ok: true,
      carry: { session: { env: ['AGENTDECK_TESTS_NOTE'] }, env: { AGENTDECK_TESTS_NOTE: '1' } },
    });
  });

  it('a kit that did not compose, or one with a raw CLI flag, refuses the start by name', () => {
    const broken = deps(() => {
      throw new Error('kit source missing');
    });
    expect(createForeignCarry(broken.deps)({ cli: 'qwen', cwd: 'C:/proj' })).toEqual({
      ok: false,
      reason: 'the panel kit did not compose: kit source missing',
    });
    const raw = deps(() => ({ args: ['--settings', 'C:/x.json'], env: {} }));
    expect(createForeignCarry(raw.deps)({ cli: 'qwen', cwd: 'C:/proj' })).toMatchObject({
      ok: false,
      reason: /panel flag --settings has no core session field/,
    });
  });
});

// Ход чата чужого CLI идёт исполнителем панели `CoreChatRun` (W3-17a): слой ему кладёт тот же
// `createForeignCarry`, что собирает сборка сервера (`foreignCarry` в `chat-wiring.ts`).
describe('a foreign CLI chat turn carries the layer through CoreChatRun', () => {
  it('session fields go into the estimate fields, the env values into the estimate body only', async () => {
    const envs: Array<Record<string, string> | undefined> = [];
    const core = coreWithTurns({ sessionId: 'qwen-conv', answer: 'ok', turnAt: 1 });
    const port: CoreChatPort = {
      ...core.port,
      estimate: (fields, env, attachments) => {
        envs.push(env);
        return core.port.estimate(fields, env, attachments);
      },
    };
    const d = deps(() => ({ args: [], env: { QWEN_HOME: 'C:/kit/qwen-home' } }));
    const entries = new Map<string, CoreChatEntry>();
    const book: CoreChatBook = {
      get: (id) => entries.get(id),
      cliOf: (id) => entries.get(id)?.cli,
      set: (id, e) => void entries.set(id, e),
      forget: (id) => void entries.delete(id),
    };
    const run = new CoreChatRun({
      port,
      book,
      pollMs: 1,
      activeCli: () => 'qwen',
      foreignCarry: createForeignCarry(d.deps),
    });
    await run.start({ prompt: 'go', cwd: 'C:/proj' }, () => undefined);
    expect(d.seen).toEqual([{ provider: 'qwen', local: false, hasSources: false }]);
    expect(core.estimates[0]!.session).toEqual({
      append: 'TESTS_LINE',
      env: ['AGENTDECK_TESTS_NOTE', 'QWEN_HOME'],
    });
    expect(envs[0]).toEqual({ AGENTDECK_TESTS_NOTE: '1', QWEN_HOME: 'C:/kit/qwen-home' });
    expect(JSON.stringify(core.estimates[0])).not.toContain('qwen-home');
    expect(core.calls.find((c) => c.kind === 'set-cli')?.fields).toMatchObject({ adapter: 'qwen' });
  });
});
