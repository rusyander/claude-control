import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeProvider } from '../providers/claude.ts';
import { getProvider } from '../providers/registry.ts';
import { setStoredKey } from '../lib/provider-keys.ts';
import {
  resolveKey,
  resolveRunner,
  canHoldKey,
  describeProviderKeys,
  describeActiveRunner,
  saveProviderKey,
  deleteProviderKey,
  ProviderKeyError,
} from './provider-keys.ts';

/**
 * Резолвинг ключей и раннера ассистента (Ф6a). Ключи кладём в изолированный
 * tmp-appData (не настоящий ~); env-переменные ставим/чистим руками; детект CLI
 * инъектируем, чтобы тест не зависел от установленных бинарей.
 */
const codex = getProvider('codex');
const cursor = getProvider('cursor');
const opencode = getProvider('opencode');

/** Детект «CLI не найден никогда» и «CLI найден всегда» — для проверки веток. */
const noCli = (): boolean => false;
const yesCli = (): boolean => true;

function fakeStore(provider: string) {
  return { getSettings: () => ({ provider }) };
}

describe('resolveKey: приоритет stored > env', () => {
  let dir: string;
  const ENV = 'OPENAI_API_KEY';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-rk-'));
    delete process.env[ENV];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env[ENV];
  });

  it('нет ни stored, ни env → present:false', () => {
    const status = resolveKey(codex, dir);
    expect(status.present).toBe(false);
    expect(status.source).toBeNull();
    expect(status.masked).toBe('');
  });

  it('только env → source env + имя переменной', () => {
    process.env[ENV] = 'sk-env-123456789';
    const status = resolveKey(codex, dir);
    expect(status.present).toBe(true);
    expect(status.source).toBe('env');
    expect(status.envVar).toBe(ENV);
    expect(status.masked).not.toContain('123456789');
  });

  it('stored приоритетнее env', () => {
    process.env[ENV] = 'sk-env-123456789';
    setStoredKey(dir, 'codex', 'sk-stored-abcdef');
    const status = resolveKey(codex, dir);
    expect(status.source).toBe('stored');
  });

  it('подхватывает ТОЛЬКО заявленные переменные (gemini: не читает OPENAI_API_KEY)', () => {
    process.env[ENV] = 'sk-env-123456789';
    const gemini = getProvider('gemini');
    expect(resolveKey(gemini, dir).present).toBe(false);
  });
});

describe('resolveRunner: api / cli / none', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-rr-'));
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('ПРИОРИТЕТ ПОДПИСКА: ключ есть, но CLI найден → cli (не api)', () => {
    setStoredKey(dir, 'codex', 'sk-stored-abcdef');
    const r = resolveRunner(codex, dir, yesCli);
    expect(r.mode).toBe('cli');
    expect(r.reason).toBe('cli_found');
  });

  it('ключ есть, CLI НЕ найден → api (платный API как фолбэк)', () => {
    setStoredKey(dir, 'codex', 'sk-stored-abcdef');
    const r = resolveRunner(codex, dir, noCli);
    expect(r.mode).toBe('api');
    expect(r.reason).toBe('api_key');
  });

  it('нет ключа, CLI найден → cli', () => {
    const r = resolveRunner(codex, dir, yesCli);
    expect(r.mode).toBe('cli');
    expect(r.reason).toBe('cli_found');
    expect(r.cliFound).toBe(true);
  });

  it('нет ключа, CLI не найден → none (no_key_no_cli)', () => {
    const r = resolveRunner(codex, dir, noCli);
    expect(r.mode).toBe('none');
    expect(r.reason).toBe('no_key_no_cli');
  });

  it('cursor (apiKind none, cliRunnable false) → всегда none/unsupported', () => {
    expect(resolveRunner(cursor, dir, yesCli).mode).toBe('none');
    expect(resolveRunner(cursor, dir, yesCli).reason).toBe('unsupported');
    expect(canHoldKey(cursor)).toBe(false);
  });

  it('claude без ключа + claude в PATH → cli (регресс поведения чата)', () => {
    const r = resolveRunner(claudeProvider, dir, yesCli);
    expect(r.mode).toBe('cli');
    expect(r.reason).toBe('cli_found');
  });

  it('opencode: apiKeyEnvVars пуст, CLI найден → cli', () => {
    const r = resolveRunner(opencode, dir, yesCli);
    expect(r.mode).toBe('cli');
  });
});

describe('describe/мутации ключей', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-dk-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('describeProviderKeys: все провайдеры, cursor supported=false', () => {
    const items = describeProviderKeys(dir);
    const byId = new Map(items.map((i) => [i.providerId, i]));
    expect(byId.get('codex')?.supported).toBe(true);
    expect(byId.get('codex')?.apiKind).toBe('openai');
    expect(byId.get('cursor')?.supported).toBe(false);
    expect(byId.get('gemini')?.envVars).toEqual(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
  });

  it('describeActiveRunner: активный провайдер + метаданные', () => {
    const info = describeActiveRunner(fakeStore('codex'), dir, noCli);
    expect(info.providerId).toBe('codex');
    expect(info.mode).toBe('none');
    expect(info.cliRunnable).toBe(true);
  });

  it('saveProviderKey → api после сохранения, статус маскирован', () => {
    const status = saveProviderKey(dir, 'codex', 'sk-stored-abcdef123');
    expect(status.present).toBe(true);
    expect(status.source).toBe('stored');
    expect(status.masked).not.toContain('abcdef123');
    expect(resolveRunner(codex, dir, noCli).mode).toBe('api');
  });

  it('deleteProviderKey очищает', () => {
    saveProviderKey(dir, 'codex', 'sk-stored-abcdef123');
    const status = deleteProviderKey(dir, 'codex');
    expect(status.present).toBe(false);
  });

  it('saveProviderKey для cursor (apiKind none) → ошибка unsupported_provider', () => {
    expect(() => saveProviderKey(dir, 'cursor', 'x')).toThrow(ProviderKeyError);
    try {
      saveProviderKey(dir, 'cursor', 'x');
    } catch (e) {
      expect((e as ProviderKeyError).code).toBe('unsupported_provider');
    }
  });

  it('saveProviderKey для неизвестного провайдера → unknown_provider', () => {
    try {
      saveProviderKey(dir, 'nope', 'x');
    } catch (e) {
      expect((e as ProviderKeyError).code).toBe('unknown_provider');
    }
  });

  it('пустой ключ → invalid_key', () => {
    try {
      saveProviderKey(dir, 'codex', '   ');
    } catch (e) {
      expect((e as ProviderKeyError).code).toBe('invalid_key');
    }
  });
});
