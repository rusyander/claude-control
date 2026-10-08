import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canHoldKey, getRawKey, resolveRunner } from '../../domains/provider-keys/provider-keys.ts';
import {
  ProviderChatRun,
  type ProviderChatRunEvent,
} from '../../domains/provider-chat/ProviderChatRun/ProviderChatRun.ts';
import { getProvider } from '../registry.ts';

/**
 * SF-1 у источника: у Continue нет своего модельного API, и без `cn` панель не
 * должна ни отвечать моделью Claude под его именем, ни держать для него ключ.
 * Подменены только поиск бинаря в PATH и `fetch` (внешние границы).
 */
describe('continue: без cn — честный отказ, а не Claude', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-continue-api-'));
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-sentinel');
    vi.stubEnv('CONTINUE_API_KEY', 'sentinel-continue');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const provider = getProvider('continue');

  it('каталог: apiKind none, переменных ключа нет, ключ не хранится', () => {
    expect(provider.assistant?.apiKind).toBe('none');
    expect(provider.assistant?.apiKeyEnvVars).toEqual([]);
    expect(canHoldKey(provider)).toBe(false);
    expect(getRawKey(provider, dir)).toBeNull();
  });

  it('раннер: ключ Anthropic в окружении не делает режим `api`', () => {
    const runner = resolveRunner(provider, dir, () => false);
    expect(runner.mode).toBe('none');
    expect(runner.reason).toBe('no_key_no_cli');
  });

  it('раннер: cn найден — режим `cli` (подписка/конфиг Continue)', () => {
    expect(resolveRunner(provider, dir, () => true).mode).toBe('cli');
  });

  it('чат без cn: отказ `no_key_no_cli`, ни одного сетевого запроса', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const events: ProviderChatRunEvent[] = [];
    await new ProviderChatRun().start(
      {
        provider,
        history: [{ id: 'm1', role: 'user', content: 'Вопрос', at: '2026-01-01T00:00:00.000Z' }],
        chatId: 'chat',
        appDataDir: dir,
        detect: () => false,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      } as Parameters<ProviderChatRun['start']>[0],
      (event) => events.push(event),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    const error = events.find((event) => event.type === 'error');
    expect(error).toMatchObject({ type: 'error', reason: 'no_key_no_cli' });
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });
});
