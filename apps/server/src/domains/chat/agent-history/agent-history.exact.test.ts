import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LIVE_STALE_MS } from '@agentdeck/contracts/agent-live';
import { FULL_READ_LIMIT } from '../ChatTranscriptFile/ChatTranscriptFile.ts';
import {
  AnomalyTally,
  hookDenialReason,
  isInterruptedResult,
} from '../subagent-tree/agent-anomalies.ts';
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
      lastAction: 'Готово', // последняя реплика m6, все вызовы с результатом
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

  it('отметки сессий — кто именно работает и чем занят главный; сумма = числам рядом с кнопкой', () => {
    const fx = seedGroup(root);
    const history = readAgentHistory(
      fx.projectsDir,
      historyKeys(fx.links, 's-fix'),
      's-fix',
      probe(Date.now()),
    );
    const [fix, work] = history.sessions;
    expect(fix?.chatId).toBe('s-fix');
    expect(fix?.liveMain).toBe(true);
    expect(fix?.liveAgents).toEqual(['toolu_f1']);
    // Открытый вызов главного — Agent «Поправить фильтр дат» с минуты 61 фикстуры.
    expect(fix?.main.openTool).toMatchObject({
      name: 'Agent',
      summary: 'Поправить фильтр дат',
      startedAt: at(61),
    });
    expect(fix?.main.lastAction).toBe('Agent: Поправить фильтр дат');
    // Законченная сессия — отметки пустые (но есть), последнее действие — на месте.
    expect(work?.liveMain).toBe(false);
    expect(work?.liveAgents).toEqual([]);
    expect(work?.main.openTool).toBeUndefined();
    expect(work?.main.lastAction).toBe('Готово');
  });

  it('молчащая сессия: отметки пустые, хоть ход и открыт; живой процесс держит только главного', () => {
    const fx = seedGroup(root);
    const keys = historyKeys(fx.links, 's-fix');
    const later = Date.now() + LIVE_STALE_MS + 1000;
    const quiet = readAgentHistory(fx.projectsDir, keys, 's-fix', probe(later)).sessions[0];
    expect(quiet?.main.turnOpen).toBe(true);
    expect(quiet?.liveMain).toBe(false);
    expect(quiet?.liveAgents).toEqual([]);
    const alive = readAgentHistory(fx.projectsDir, keys, 's-fix', probe(later, true)).sessions[0];
    expect(alive?.liveMain).toBe(true);
    expect(alive?.liveAgents).toEqual([]);
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

/** Так CLI закрывает вызов, оборванный паузой или концом сессии (с `is_error`). */
const CUT =
  "[Tool call interrupted: the session ended before this call's result was recorded. Re-run the call if it is still needed.]";

describe('история агентов: вызов, оборванный паузой, — «прервано», не ошибка', () => {
  let root: string;

  beforeEach(() => {
    resetAgentHistoryCache();
    resetAgentDigestCache();
    root = mkdtempSync(join(tmpdir(), 'cc-agent-history-cut-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** s-fix: Bash без результата, затем пауза закрывает его и вызов Agent отметкой CLI. */
  function seedCut() {
    const fx = seedGroup(root);
    const record = (value: unknown) => `${JSON.stringify(value)}\n`;
    const cut = (id: string) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: CUT,
      is_error: true,
    });
    appendFileSync(
      fx.fixPath,
      record({
        type: 'assistant',
        timestamp: at(62),
        message: {
          id: 'f2',
          model: 'claude-opus-4-1',
          content: [{ type: 'tool_use', id: 'bx', name: 'Bash', input: { command: 'pnpm test' } }],
        },
      }) +
        record({
          type: 'user',
          timestamp: at(90),
          message: { role: 'user', content: [cut('toolu_f1'), cut('bx')] },
        }),
    );
    return fx;
  }

  it('шаг хода — interrupted без isError; странности — «прервано 2», ошибок 0', () => {
    const fx = seedCut();
    const pane = readMainAgent(fx.projectsDir, 's-fix', { limit: 50 });
    const bash = pane?.steps.find((step) => step.name === 'Bash');
    expect(bash).toMatchObject({ interrupted: true, result: CUT });
    expect(bash?.isError).toBeUndefined();
    const history = readAgentHistory(
      fx.projectsDir,
      historyKeys(fx.links, 's-fix'),
      's-fix',
      probe(Date.now(), true),
    );
    // Agent toolu_f1 и Bash bx — оба оборваны; настоящих ошибок в s-fix нет.
    expect(history.sessions[0]?.main.anomalies).toEqual({
      denials: 0,
      errors: 0,
      repeatedReads: [],
      largeResults: 0,
      interrupted: 2,
    });
  });

  it('субагент, оборванный паузой, — interrupted, не идёт и не в счёт «сейчас»', () => {
    const fx = seedCut();
    const history = readAgentHistory(
      fx.projectsDir,
      historyKeys(fx.links, 's-fix'),
      's-fix',
      probe(Date.now(), true),
    );
    expect(history.sessions[0]?.agents[0]).toMatchObject({
      id: 'toolu_f1',
      status: 'failed',
      interrupted: true,
    });
    expect(history.sessions[0]?.liveAgents).toEqual([]);
    expect(history.live.subagents).toBe(0);
  });

  it('настоящая ошибка рядом с обрывом остаётся ошибкой', () => {
    const tally = new AnomalyTally();
    tally.result({ kind: 'tool', isError: true, result: 'exit 1' });
    tally.result({ kind: 'tool', interrupted: true, result: CUT });
    expect(tally.snapshot()).toMatchObject({ errors: 1, interrupted: 1 });
    expect(isInterruptedResult(CUT)).toBe(true);
    expect(isInterruptedResult('exit 1: [Tool call interrupted]')).toBe(false);
  });
});
