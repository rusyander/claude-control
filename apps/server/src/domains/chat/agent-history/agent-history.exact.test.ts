import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LIVE_STALE_MS } from '@agentdeck/contracts/agent-live';
import { FULL_READ_LIMIT } from '../ChatTranscriptFile/ChatTranscriptFile.ts';
import { AnomalyTally, hookDenialReason } from '../subagent-tree/agent-anomalies.ts';
import { resetAgentDigestCache } from '../subagent-tree/agent-digest.ts';
import { readAgentTranscript } from '../subagent-tree/subagent-tree.ts';
import {
  historyKeys,
  readAgentHistory,
  readMainAgent,
  resetAgentHistoryCache,
  type LiveProbe,
} from './agent-history.ts';
import { at, seedGroup } from './agent-history.fixture.ts';
import { DENIAL_TEXT, seedExact, seedLarge } from './agent-history.exact.fixture.ts';

/**
 * Числа истории совпадают с транскриптом ТОЧНО: ожидания посчитаны руками по
 * фикстуре (`agent-history.exact.fixture.ts`), а не тем же кодом. Плюс файл
 * больше порога «начало и хвост» читается целиком, окно хода главного агента
 * листается, а «сейчас работают» не держит оборванного субагента вечно.
 */
const probe = (now: number, alive = false): LiveProbe => ({ now, alive: () => alive });

describe('история агентов: точные числа', () => {
  let root: string;

  beforeEach(() => {
    resetAgentHistoryCache();
    resetAgentDigestCache();
    root = mkdtempSync(join(tmpdir(), 'cc-agent-history-exact-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('главный агент: расход по каждому ответу один раз, вызовы, странности — посчитано руками', () => {
    const { projectsDir } = seedExact(root);
    const history = readAgentHistory(projectsDir, [{ chatId: 's-exact' }], 's-exact', probe(0));
    const session = history.sessions[0];
    expect(session?.main).toEqual({
      // Read r1, Read r2, Bash b1, Bash b2, Agent toolu_x1.
      toolCalls: 5,
      tokens: {
        input: 2100, // 100 + 200 + 300 + 400 + 500 + 600 (m1 — итог второй строки)
        output: 210, // 10 + 20 + 30 + 40 + 50 + 60 (у m1 промежуточная 1 не в счёт)
        cacheRead: 21000, // 1000 + 2000 + 3000 + 4000 + 5000 + 6000
        cacheCreation: 55, // 50 + 0 + 0 + 5 + 0 + 0
      },
      model: 'claude-opus-4-1',
      anomalies: {
        denials: 1, // b1 — отказ destructive-guard
        errors: 1, // b2 — exit 1, не отказ
        repeatedReads: [{ path: '/a.ts', count: 2 }],
        largeResults: 1, // r1 — 12 000 символов
      },
    });
    expect(session?.startedAt).toBe(at(0));
    expect(session?.endedAt).toBe(at(31));
  });

  it('субагент: свой расход и странности по своему файлу — посчитано руками', () => {
    const { projectsDir } = seedExact(root);
    const history = readAgentHistory(projectsDir, [{ chatId: 's-exact' }], 's-exact', probe(0));
    const session = history.sessions[0];
    expect(session?.agents).toHaveLength(1);
    expect(session?.agents[0]).toMatchObject({
      agentId: 'ax1',
      status: 'done',
      toolCalls: 2, // g1, g2
      tokens: {
        input: 41, // 11 + 13 + 17
        output: 10, // 2 + 3 + 5 (у s3 промежуточная 1 не в счёт)
        cacheRead: 1200, // 300 + 400 + 500
        cacheCreation: 7,
      },
    });
    expect(session?.anomalies).toEqual({
      ax1: { denials: 1, errors: 0, repeatedReads: [{ path: '/t.ts', count: 2 }], largeResults: 0 },
    });
    const sub = readAgentTranscript(projectsDir, 's-exact', 'ax1', { limit: 50, offset: 0 });
    expect(sub?.tokens).toEqual({ input: 41, output: 10, cacheRead: 1200, cacheCreation: 7 });
    expect(sub?.toolCalls).toBe(2);
  });

  it('ход главного агента: каждый вызов с временем, размером, отказом; расход и модель ответа', () => {
    const { projectsDir } = seedExact(root);
    const main = readMainAgent(projectsDir, 's-exact', { limit: 200, offset: 0 });
    expect(main?.agentId).toBe('main');
    expect(main?.prompt).toBe('Проверь отчёты');
    expect(main?.total).toBe(7); // размышление, 5 вызовов, реплика
    expect(main?.toolCalls).toBe(5);
    const [thinking, r1, r2, b1, b2, agent, text] = main?.steps ?? [];
    expect(thinking).toMatchObject({
      kind: 'thinking',
      model: 'claude-opus-4-1',
      usage: { input: 100, output: 10, cacheRead: 1000, cacheCreation: 50 },
    });
    expect(r1).toMatchObject({
      name: 'Read',
      summary: '/a.ts',
      durationMs: 60_000,
      resultChars: 12_000,
    });
    expect(r1?.usage).toBeUndefined();
    expect(r2).toMatchObject({ durationMs: 120_000, resultChars: 2, usage: { input: 200 } });
    expect(b1).toMatchObject({
      name: 'Bash',
      isError: true,
      denial: '[destructive-guard] rm -rf запрещён',
      resultChars: DENIAL_TEXT.length,
      durationMs: 0,
    });
    expect(b2).toMatchObject({ isError: true, result: 'exit 1' });
    expect(b2?.denial).toBeUndefined();
    expect(agent).toMatchObject({ name: 'Agent', durationMs: 21 * 60_000 });
    expect(text).toMatchObject({ kind: 'text', text: 'Готово', usage: { output: 60 } });
  });

  it('транскрипт больше порога «начало и хвост» читается целиком; окно листается с номера шага', () => {
    const calls = 2500;
    const { projectsDir, path } = seedLarge(root, calls);
    expect(statSync(path).size).toBeGreaterThan(FULL_READ_LIMIT);
    const history = readAgentHistory(projectsDir, [{ chatId: 's-large' }], 's-large', probe(0));
    expect(history.sessions[0]?.main).toMatchObject({
      toolCalls: calls,
      tokens: { input: calls, output: calls, cacheRead: 0, cacheCreation: 0 },
    });
    const tail = readMainAgent(projectsDir, 's-large', { limit: 200, offset: 0 });
    expect(tail).toMatchObject({ total: calls, start: calls - 200, hasMore: true });
    expect(tail?.steps).toHaveLength(200);
    const middle = readMainAgent(projectsDir, 's-large', { limit: 3, start: 1200 });
    expect(middle?.steps.map((step) => step.summary)).toEqual([
      'echo 1200',
      'echo 1201',
      'echo 1202',
    ]);
    const first = readMainAgent(projectsDir, 's-large', { limit: 2, start: 0 });
    expect(first).toMatchObject({ start: 0, hasMore: false });
    expect(first?.steps[0]?.summary).toBe('echo 0');
  });
});

describe('странности агента: что считается', () => {
  it('повторное чтение — файл прочитан больше одного раза; единожды прочитанный не в счёт', () => {
    const tally = new AnomalyTally();
    tally.read('/once.ts');
    tally.read('/b.ts');
    tally.read('/b.ts');
    tally.read('/b.ts');
    expect(tally.snapshot().repeatedReads).toEqual([{ path: '/b.ts', count: 3 }]);
  });

  it('отказ хука узнаётся по тексту результата CLI; обычная ошибка — не отказ', () => {
    expect(hookDenialReason('PreToolUse:Bash hook error: [git-guard] нужен ответ')).toBe(
      '[git-guard] нужен ответ',
    );
    expect(hookDenialReason('exit 1')).toBeUndefined();
  });
});

describe('история агентов: кто работает сейчас', () => {
  let root: string;

  beforeEach(() => {
    resetAgentHistoryCache();
    resetAgentDigestCache();
    root = mkdtempSync(join(tmpdir(), 'cc-agent-history-live-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('открытый ход главного и субагент без итога, писавший только что, — работают', () => {
    const fx = seedGroup(root);
    const history = readAgentHistory(
      fx.projectsDir,
      historyKeys(fx.links, 's-fix'),
      's-fix',
      probe(Date.now()),
    );
    // s-fix: вызов Agent без результата — ход открыт, af1 без итога; s-work закончена.
    expect(history.live).toEqual({ agents: 1, subagents: 1 });
    expect(history.sessions[0]?.main.turnOpen).toBe(true);
    expect(history.sessions[1]?.main.turnOpen).toBeUndefined();
  });

  it('оборванный субагент молчит дольше порога — не работает, даже при живом процессе', () => {
    const fx = seedGroup(root);
    const keys = historyKeys(fx.links, 's-fix');
    const later = Date.now() + LIVE_STALE_MS + 1000;
    expect(readAgentHistory(fx.projectsDir, keys, 's-fix', probe(later)).live).toEqual({
      agents: 0,
      subagents: 0,
    });
    // Процесс жив — ход главного открыт и он работает; субагент без итога — уже нет.
    expect(readAgentHistory(fx.projectsDir, keys, 's-fix', probe(later, true)).live).toEqual({
      agents: 1,
      subagents: 0,
    });
  });

  it('ответ, законченный моделью (end_turn), закрывает ход и при незакрытом вызове', () => {
    const fx = seedGroup(root);
    appendFileSync(
      fx.fixPath,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: at(62),
        message: {
          id: 'f2',
          model: 'claude-opus-4-1',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Агент работает в фоне, жду итога' }],
        },
      })}\n`,
    );
    const keys = historyKeys(fx.links, 's-fix');
    const history = readAgentHistory(fx.projectsDir, keys, 's-fix', probe(Date.now(), true));
    expect(history.sessions[0]?.main.turnOpen).toBeUndefined();
    // Ход главного закрыт, его фоновый субагент без итога пишет — работает он один.
    expect(history.live).toEqual({ agents: 0, subagents: 1 });
  });

  it('ход, прерванный человеком, закрыт: живой процесс его не держит', () => {
    const fx = seedGroup(root);
    appendFileSync(
      fx.fixPath,
      `${JSON.stringify({
        type: 'user',
        timestamp: at(62),
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
        },
      })}\n`,
    );
    const keys = historyKeys(fx.links, 's-fix');
    const history = readAgentHistory(fx.projectsDir, keys, 's-fix', probe(Date.now(), true));
    expect(history.sessions[0]?.main.turnOpen).toBeUndefined();
    expect(history.live.agents).toBe(0);
  });
});
