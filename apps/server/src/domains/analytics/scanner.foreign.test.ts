import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanAnalytics } from './scanner.ts';
import type { ScanOptions } from './scanner.ts';

/**
 * Аналитика сессий Codex и Qwen Code (пункт 7 «Цели», 06.10.2026). Строки —
 * формы, которые написали НАСТОЯЩИЕ codex 0.160 и qwen 0.25.0 во временном доме
 * (лишние поля срезаны, числа подобраны так, чтобы ошибка была видна): у
 * обоих на один ответ больше одного следа, и вход считается вместе с кэшем.
 *
 * Дом CLI — временная папка с той же раскладкой, что у CLI; сканер получает её
 * через `source`, как маршрут при активном Codex / Qwen.
 */

const recent = (minutesAgo = 60): string =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

const PRICE = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 0 };

describe('scanAnalytics — чужие CLI', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-foreign-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function write(path: string, rows: unknown[]): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  }

  const options = (kind: 'codex' | 'qwen', extra: Partial<ScanOptions> = {}): ScanOptions => ({
    days: 30,
    recentSessionsLimit: 10,
    strictPricing: true,
    source: { kind, homes: [home] },
    ...extra,
  });

  // ── Codex ──────────────────────────────────────────────────────────────

  const SESSION = '01a111ce-08b0-7a12-822a-7abdc4874e3e';
  const CWD = 'C:\\work\\demo';

  function codexMeta(ts: string): unknown {
    return {
      timestamp: ts,
      type: 'session_meta',
      payload: { session_id: SESSION, id: SESSION, cwd: CWD, cli_version: '0.160.0' },
    };
  }

  function turn(ts: string, turnId: string, model: string): unknown {
    return { timestamp: ts, type: 'turn_context', payload: { turn_id: turnId, cwd: CWD, model } };
  }

  function usage(input: number, cached: number, output: number) {
    return {
      input_tokens: input,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: input + output,
    };
  }

  function record(
    ts: string,
    turnId: string,
    responseId: string,
    input: number,
    cached: number,
    output: number,
  ): unknown {
    return {
      timestamp: ts,
      type: 'token_usage_record',
      payload: {
        session_id: SESSION,
        turn_id: turnId,
        response_id: responseId,
        usage: usage(input, cached, output),
      },
    };
  }

  /** Дубль того же ответа, который codex пишет рядом с записью. */
  function tokenCount(ts: string, input: number, cached: number, output: number): unknown {
    return {
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: usage(input, cached, output),
          last_token_usage: usage(input, cached, output),
        },
      },
    };
  }

  function call(ts: string, name: string): unknown {
    return {
      timestamp: ts,
      type: 'response_item',
      payload: { type: 'function_call', name, arguments: '{}' },
    };
  }

  const rollout = (name = 'rollout-2026-10-06T20-21-17-a.jsonl'): string =>
    join(home, 'sessions', '2026', '10', '06', name);

  it('Codex: вход без кэша, кэш отдельно, дубль token_count не удваивает', async () => {
    const ts = recent();
    write(rollout(), [
      codexMeta(ts),
      turn(ts, 't1', 'gpt-5-codex'),
      record(ts, 't1', 'resp_1', 1000, 600, 50),
      tokenCount(ts, 1000, 600, 50),
      call(ts, 'shell'),
      record(ts, 't1', 'resp_2', 1200, 1000, 30),
      tokenCount(ts, 1200, 1000, 30),
      call(ts, 'shell'),
      call(ts, 'apply_patch'),
    ]);

    const result = await scanAnalytics(join(home, 'нет'), options('codex'));
    expect(result.providerId).toBe('codex');
    expect(result.overall).toMatchObject({ input: 600, cacheRead: 1600, output: 80, requests: 2 });
    expect(result.byModel.map((m) => m.model)).toEqual(['gpt-5-codex']);
    expect(result.cacheHitRatio).toBeCloseTo(1600 / 2200);
    expect(result.topTools).toEqual([
      { name: 'shell', count: 2 },
      { name: 'apply_patch', count: 1 },
    ]);
    expect(result.recentSessions[0]).toMatchObject({ sessionId: SESSION });
    expect(result.byProject).toHaveLength(1);
    expect(result.byProject[0]?.project).toMatch(/work[\\/]demo$/i);
  });

  it('Codex: модель берётся из своего хода, а не из последнего', async () => {
    const ts = recent();
    write(rollout(), [
      codexMeta(ts),
      turn(ts, 't1', 'gpt-5-codex'),
      turn(ts, 't2', 'gpt-5.1'),
      record(ts, 't1', 'resp_1', 100, 0, 10),
      record(ts, 't2', 'resp_2', 100, 0, 10),
    ]);
    const result = await scanAnalytics(home, options('codex'));
    expect(result.byModel.map((m) => m.model).sort()).toEqual(['gpt-5-codex', 'gpt-5.1']);
  });

  it('Codex: файл без token_usage_record (старый codex) — считается по token_count', async () => {
    const ts = recent();
    write(rollout(), [
      codexMeta(ts),
      turn(ts, 't1', 'gpt-5'),
      tokenCount(ts, 500, 200, 20),
      tokenCount(ts, 700, 500, 5),
    ]);
    const result = await scanAnalytics(home, options('codex'));
    expect(result.overall).toMatchObject({ input: 500, cacheRead: 700, output: 25, requests: 2 });
  });

  it('Codex: архив тоже читается, чужие файлы в sessions — нет', async () => {
    const ts = recent();
    const rows = [codexMeta(ts), turn(ts, 't1', 'gpt-5'), record(ts, 't1', 'r', 10, 0, 1)];
    write(join(home, 'archived_sessions', 'rollout-old.jsonl'), rows);
    write(join(home, 'sessions', '2026', '10', '06', 'notes.jsonl'), rows);
    const result = await scanAnalytics(home, options('codex'));
    expect(result.scannedFiles).toBe(1);
    expect(result.overall.requests).toBe(1);
  });

  it('модель без цены — ноль и пометка, модель с ценой — по своей ставке', async () => {
    const ts = recent();
    write(rollout(), [
      codexMeta(ts),
      turn(ts, 't1', 'gpt-5-codex'),
      record(ts, 't1', 'resp_1', 1_000_000, 0, 0),
      turn(ts, 't2', 'stub-chat'),
      record(ts, 't2', 'resp_2', 1_000_000, 0, 0),
    ]);
    const result = await scanAnalytics(
      home,
      options('codex', { pricing: { 'gpt-5-codex': PRICE } }),
    );
    expect(result.unpricedModels).toEqual(['stub-chat']);
    expect(result.estimatedCost).toBeCloseTo(1);
    const stub = result.byModel.find((m) => m.model === 'stub-chat');
    expect(stub?.estimatedCost).toBe(0);
  });

  it('без strictPricing неизвестная модель считается запасной ставкой (поведение Claude)', async () => {
    const ts = recent();
    write(rollout(), [
      codexMeta(ts),
      turn(ts, 't1', 'stub-chat'),
      record(ts, 't1', 'r', 1_000_000, 0, 0),
    ]);
    const result = await scanAnalytics(home, options('codex', { strictPricing: false }));
    expect(result.unpricedModels).toBeUndefined();
    expect(result.estimatedCost).toBeGreaterThan(0);
  });

  // ── Qwen ───────────────────────────────────────────────────────────────

  const QWEN_SESSION = '8dd3f850-8dba-40e6-9d7b-7de2cd2057e8';
  const QWEN_CWD = 'C:\\work\\qwen-demo';

  const qbase = (ts: string, type: string) => ({
    uuid: `${type}-${Math.random()}`,
    sessionId: QWEN_SESSION,
    timestamp: ts,
    type,
    cwd: QWEN_CWD,
    version: '0.25.0',
  });

  function qUser(ts: string): unknown {
    return { ...qbase(ts, 'user'), message: { role: 'user', parts: [{ text: 'привет' }] } };
  }

  function qTelemetry(
    ts: string,
    id: string,
    input: number,
    cached: number,
    output: number,
    thoughts = 0,
  ): unknown {
    return {
      ...qbase(ts, 'system'),
      subtype: 'ui_telemetry',
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.api_response',
          response_id: id,
          model: 'qwen3-coder-plus',
          input_token_count: input,
          output_token_count: output,
          cached_content_token_count: cached,
          thoughts_token_count: thoughts,
        },
      },
    };
  }

  function qAssistant(
    ts: string,
    input: number,
    cached: number,
    output: number,
    tool?: string,
  ): unknown {
    return {
      ...qbase(ts, 'assistant'),
      model: 'qwen3-coder-plus',
      message: {
        role: 'model',
        parts: [{ text: 'готово' }, ...(tool ? [{ functionCall: { name: tool, args: {} } }] : [])],
      },
      usageMetadata: {
        promptTokenCount: input,
        candidatesTokenCount: output,
        thoughtsTokenCount: 0,
        cachedContentTokenCount: cached,
      },
    };
  }

  const chat = (): string =>
    join(home, 'projects', 'c--work-qwen-demo', 'chats', `${QWEN_SESSION}.jsonl`);

  it('Qwen: телеметрия — каждый запрос, включая фоновый; usageMetadata того же ответа не удваивает', async () => {
    const ts = recent();
    write(chat(), [
      qUser(ts),
      qTelemetry(ts, 'c1', 1000, 600, 7, 3),
      qAssistant(ts, 1000, 600, 7, 'read_file'),
      // Фоновое извлечение памяти: только телеметрия, ответа человеку нет.
      qTelemetry(ts, 'c2', 400, 0, 20),
    ]);
    const result = await scanAnalytics(home, options('qwen'));
    expect(result.providerId).toBe('qwen');
    expect(result.overall).toMatchObject({ input: 800, cacheRead: 600, output: 30, requests: 2 });
    expect(result.topTools).toEqual([{ name: 'read_file', count: 1 }]);
    expect(result.recentSessions[0]).toMatchObject({ sessionId: QWEN_SESSION });
  });

  it('Qwen: файл без телеметрии — считается по usageMetadata', async () => {
    const ts = recent();
    write(chat(), [qUser(ts), qAssistant(ts, 1000, 600, 7), qAssistant(ts, 300, 100, 3)]);
    const result = await scanAnalytics(home, options('qwen'));
    expect(result.overall).toMatchObject({ input: 600, cacheRead: 700, output: 10, requests: 2 });
  });

  it('Qwen: дома — список без повторов; второй дом (набор панели) тоже читается', async () => {
    const ts = recent();
    write(chat(), [qUser(ts), qTelemetry(ts, 'c1', 10, 0, 1)]);
    const kit = mkdtempSync(join(tmpdir(), 'cc-foreign-kit-'));
    try {
      write(join(kit, 'projects', 'p', 'chats', 'other.jsonl'), [
        qUser(ts),
        qTelemetry(ts, 'k1', 10, 0, 1),
      ]);
      const result = await scanAnalytics(home, {
        ...options('qwen'),
        source: { kind: 'qwen', homes: [home, home, kit] },
      });
      expect(result.scannedFiles).toBe(2);
      expect(result.overall.requests).toBe(2);
    } finally {
      rmSync(kit, { recursive: true, force: true });
    }
  });

  it('обрезанная последняя строка идущей сессии не роняет разбор', async () => {
    const ts = recent();
    write(rollout(), [codexMeta(ts), turn(ts, 't1', 'gpt-5'), record(ts, 't1', 'r', 10, 0, 1)]);
    writeFileSync(rollout(), '{"timestamp":"' + ts + '","type":"token_usage_rec', { flag: 'a' });
    const result = await scanAnalytics(home, options('codex'));
    expect(result.overall.requests).toBe(1);
  });

  it('старые записи отсекаются окном, как у Claude', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();
    const ts = recent();
    write(rollout(), [
      codexMeta(old),
      turn(old, 't1', 'gpt-5'),
      record(old, 't1', 'old', 999, 0, 9),
      turn(ts, 't2', 'gpt-5'),
      record(ts, 't2', 'new', 10, 0, 1),
    ]);
    const result = await scanAnalytics(home, options('codex'));
    expect(result.overall).toMatchObject({ input: 10, requests: 1 });
  });
});
