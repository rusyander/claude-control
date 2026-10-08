import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { PricingStore } from '../../domains/analytics/pricing-source.ts';
import { getRunningAgents } from '../../domains/analytics/runtime.ts';
import type { ServerContext } from '../../context.ts';
import { registerAnalyticsRoutes } from './analytics-routes.ts';

// Обход процессов машины — граница теста: подменяем, а вызовы считаем — под
// чужим CLI до него вообще не должно дойти.
vi.mock('../../domains/analytics/runtime.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../domains/analytics/runtime.ts')>()),
  getRunningAgents: vi.fn(async () => [
    { pid: 4242, name: 'claude', memoryMb: 1, cwd: '/qa', startedAt: '' },
  ]),
  getSkillUsage: vi.fn(() => []),
}));

/**
 * Аналитика под CLI, журналы которого она не читает (SF-4). Маршрут молча
 * падал на `~/.claude/projects`, и под goose/kimi/gemini… отдавал расход Claude —
 * телефон без гейта возможностей рисовал его как есть. Теперь: 409 с кодом и
 * именем CLI, сумма Claude не уезжает ни в одном поле; Claude, Codex и Qwen
 * работают как прежде.
 */
const CLAUDE_INPUT = 9_173_521;
const REFUSED = ['gemini', 'goose', 'kimi', 'cursor', 'opencode', 'aider', 'continue'];

describe('аналитика под CLI без своих журналов', () => {
  let root: string;
  let codexDir: string;
  let app: FastifyInstance;
  let store: AppStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-analytics-refusal-'));
    codexDir = mkdtempSync(join(tmpdir(), 'cc-analytics-refusal-codex-'));
    // Дом Codex человека тест не читает.
    vi.stubEnv('CODEX_HOME', codexDir);
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    mkdirSync(join(root, 'projects', 'proj'), { recursive: true });
    writeFileSync(
      join(root, 'projects', 'proj', 'sess.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        sessionId: 'qa-claude-session',
        cwd: '/work/qa-claude-project',
        message: {
          id: 'msg-refusal',
          model: 'claude-opus-4-8',
          usage: { input_tokens: CLAUDE_INPUT, output_tokens: 0 },
        },
      })}\n`,
    );
    store = new AppStore(appData);
    const ctx = {
      location: { paths: { root, appData, mcpConfig: join(root, '.claude.json') } },
      store,
      pricing: new PricingStore(appData),
    } as unknown as ServerContext;
    app = Fastify();
    registerAnalyticsRoutes(app, ctx);
    vi.mocked(getRunningAgents).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(codexDir, { recursive: true, force: true });
  });

  it.each(REFUSED)(
    '%s: отчёт — 409 с кодом и именем CLI, суммы Claude в ответе нет',
    async (id) => {
      store.updateSettings({ provider: id });
      const response = await app.inject({
        method: 'GET',
        url: '/api/analytics?days=30&refresh=true',
      });

      expect(response.statusCode).toBe(409);
      const body = response.json<{ messageCode: string; params: { provider: string } }>();
      expect(body.messageCode).toBe('analytics-provider-unsupported');
      expect(body.params.provider).not.toBe('');
      expect(response.body).not.toContain(String(CLAUDE_INPUT));
      expect(response.body).not.toContain('qa-claude');
    },
  );

  it('goose: живой список — тоже 409, процессы claude даже не обходятся', async () => {
    store.updateSettings({ provider: 'goose' });
    const response = await app.inject({ method: 'GET', url: '/api/analytics/live' });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ messageCode: string }>().messageCode).toBe(
      'analytics-provider-unsupported',
    );
    expect(response.body).not.toContain('4242');
    expect(getRunningAgents).not.toHaveBeenCalled();
  });

  // Z-fix 3: под Codex/Qwen отчёт уже свой, а живой список отдавал процессы
  // claude — вкладка выдавала их за процессы активного CLI. Свои процессы этих
  // CLI панель не опознаёт, поэтому список пуст и объясняет почему.
  it.each([
    ['codex', 'Codex (OpenAI)'],
    ['qwen', 'Qwen Code'],
  ])('%s: живой список пуст с причиной, процессы claude не обходятся', async (id, name) => {
    store.updateSettings({ provider: id });
    const response = await app.inject({ method: 'GET', url: '/api/analytics/live' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      runningAgents: unknown[];
      unavailable?: { messageCode: string; params: { provider: string }; message: string };
    }>();
    expect(body.runningAgents).toEqual([]);
    expect(body.unavailable?.messageCode).toBe('analytics-live-foreign');
    expect(body.unavailable?.params.provider).toBe(name);
    expect(body.unavailable?.message).toContain(name);
    expect(response.body).not.toContain('4242');
    expect(getRunningAgents).not.toHaveBeenCalled();
  });

  it('claude: отчёт по транскриптам Claude, как прежде', async () => {
    store.updateSettings({ provider: 'claude' });
    const response = await app.inject({
      method: 'GET',
      url: '/api/analytics?days=30&refresh=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ overall: { input: number } }>().overall.input).toBe(CLAUDE_INPUT);
    const live = await app.inject({ method: 'GET', url: '/api/analytics/live' });
    expect(live.statusCode).toBe(200);
    // Контроль: у Claude список настоящий и без пометки о недоступности.
    expect(live.json<{ runningAgents: Array<{ pid: number }> }>().runningAgents[0]?.pid).toBe(4242);
    expect(live.json<{ unavailable?: unknown }>().unavailable).toBeUndefined();
  });

  it('codex: отчёт своего CLI, не отказ и не сумма Claude', async () => {
    store.updateSettings({ provider: 'codex' });
    const response = await app.inject({
      method: 'GET',
      url: '/api/analytics?days=30&refresh=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ providerId?: string }>().providerId).toBe('codex');
    expect(response.body).not.toContain(String(CLAUDE_INPUT));
  });
});
