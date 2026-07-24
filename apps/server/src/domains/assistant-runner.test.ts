import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../providers/registry.ts';
import { setStoredKey } from '../lib/provider-keys.ts';
import { runAssistant, type RunAssistantDeps } from './assistant-runner.ts';

/**
 * Мультимодельный раннер ассистента (Ф6b). Реальной сети НЕТ (мокаем fetch),
 * реального spawn НЕТ (мокаем child_process). appData — изолированный tmp.
 */
const noCli = (): boolean => false;
const yesCli = (): boolean => true;

/** Фейковый spawn: пишет заданный stdout/stderr и закрывается кодом. */
function fakeSpawn(opts: { stdout?: string; stderr?: string; code?: number; delayMs?: number }) {
  const calls: { cmd: string; args: string[] }[] = [];
  const stdinChunks: string[] = [];
  const fn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: (c: string) => void; end: () => void; on: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // `on` есть у любого настоящего потока: раннер вешает на stdin обработчик
    // EPIPE — без него необработанное событие `error` потока роняет сервер.
    child.stdin = { write: (c: string) => stdinChunks.push(c), end: () => {}, on: () => {} };
    child.kill = () => child.emit('close', null);
    setTimeout(() => {
      if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
      if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
      child.emit('close', opts.code ?? 0);
    }, opts.delayMs ?? 0);
    return child;
  }) as unknown as RunAssistantDeps['spawnImpl'];
  return { fn, calls, stdinChunks };
}

/** Найти промпт как ОТДЕЛЬНЫЙ элемент argv (проверка отсутствия shell-инъекции). */
function argvHasDiscrete(args: string[], prompt: string): boolean {
  return args.filter((a) => a === prompt).length === 1;
}

describe('runAssistant: CLI one-shot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-run-cli-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('gemini → argv [-p, prompt] отдельным элементом, stdout → ответ', async () => {
    const gemini = getProvider('gemini');
    const spawn = fakeSpawn({ stdout: 'привет из gemini' });
    const prompt = 'скажи привет; echo PWNED';
    const res = await runAssistant(gemini, [{ role: 'user', content: prompt }], {
      appDataDir: dir,
      detect: yesCli,
      spawnImpl: spawn.fn,
    });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('cli');
    expect(res.experimental).toBe(true);
    expect(res.reply).toBe('привет из gemini');
    // Промпт со спецсимволами — ОДИН элемент argv (не склеен, не разбит).
    expect(argvHasDiscrete(spawn.calls[0]!.args, prompt)).toBe(true);
    expect(spawn.calls[0]!.args).toContain('-p');
  });

  it('codex → argv [exec, prompt]', async () => {
    const codex = getProvider('codex');
    const spawn = fakeSpawn({ stdout: 'ok' });
    const prompt = 'сделай что-то';
    const res = await runAssistant(codex, [{ role: 'user', content: prompt }], {
      appDataDir: dir,
      detect: yesCli,
      spawnImpl: spawn.fn,
    });
    expect(res.ok).toBe(true);
    expect(spawn.calls[0]!.args).toContain('exec');
    expect(argvHasDiscrete(spawn.calls[0]!.args, prompt)).toBe(true);
  });

  // AIDER-2: `--message <text>` — задокументированный one-shot Aider («отправить
  // одно сообщение, обработать ответ и выйти»). NB: сам `aider` на машине
  // разработки не установлен — раннер собран по документации и живым прогоном не
  // проверен; здесь фиксируем то, что можем: форму argv без shell-склейки.
  it('aider → argv [--message, prompt] отдельным элементом', async () => {
    const aider = getProvider('aider');
    const spawn = fakeSpawn({ stdout: 'ответ aider' });
    const prompt = 'почини баг; rm -rf / && echo "PWNED"';
    const res = await runAssistant(aider, [{ role: 'user', content: prompt }], {
      appDataDir: dir,
      detect: yesCli,
      spawnImpl: spawn.fn,
    });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('cli');
    // Провайдер экспериментальный — бейдж «экспериментально» остаётся.
    expect(res.experimental).toBe(true);
    expect(res.reply).toBe('ответ aider');
    expect(spawn.calls[0]!.args).toContain('--message');
    expect(argvHasDiscrete(spawn.calls[0]!.args, prompt)).toBe(true);
    // Промпт НИКОГДА не склеивается со строкой команды в один аргумент.
    expect(spawn.calls[0]!.args.some((arg) => arg.startsWith('--message '))).toBe(false);
  });

  it('ненулевой код + stderr → ошибка cli_error', async () => {
    const gemini = getProvider('gemini');
    const spawn = fakeSpawn({ stderr: 'boom', code: 1 });
    const res = await runAssistant(gemini, [{ role: 'user', content: 'x' }], {
      appDataDir: dir,
      detect: yesCli,
      spawnImpl: spawn.fn,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('cli_error');
    expect(res.error).toContain('boom');
  });

  it('пустой stdout при коде 0 → ошибка cli_error', async () => {
    const gemini = getProvider('gemini');
    const spawn = fakeSpawn({ stdout: '   ', code: 0 });
    const res = await runAssistant(gemini, [{ role: 'user', content: 'x' }], {
      appDataDir: dir,
      detect: yesCli,
      spawnImpl: spawn.fn,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('cli_error');
  });

  it('таймаут → ошибка cli_error', async () => {
    const gemini = getProvider('gemini');
    const spawn = fakeSpawn({ stdout: 'поздно', delayMs: 10_000 });
    const res = await runAssistant(gemini, [{ role: 'user', content: 'x' }], {
      appDataDir: dir,
      detect: yesCli,
      spawnImpl: spawn.fn,
      timeoutMs: 20,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('cli_error');
  });

  it('opencode (CLI есть, но флаг не задокументирован) без ключа → none', async () => {
    const opencode = getProvider('opencode');
    const spawn = fakeSpawn({ stdout: 'не должно вызваться' });
    const res = await runAssistant(opencode, [{ role: 'user', content: 'x' }], {
      appDataDir: dir,
      detect: yesCli,
      spawnImpl: spawn.fn,
    });
    // oneShotArgs нет → CLI программно не запускаем, ключа нет → none.
    expect(res.mode).toBe('none');
    expect(res.reason).toBe('no_key_no_cli');
    expect(spawn.calls.length).toBe(0);
  });
});

describe('runAssistant: приоритет подписки', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-run-prio-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('ключ есть, но CLI найден → идём в CLI (подписка), не в API', async () => {
    const gemini = getProvider('gemini');
    setStoredKey(dir, 'gemini', 'AIza-secret-key-123456');
    const spawn = fakeSpawn({ stdout: 'из cli' });
    const fetchMock = vi.fn();
    const res = await runAssistant(gemini, [{ role: 'user', content: 'x' }], {
      appDataDir: dir,
      detect: yesCli,
      spawnImpl: spawn.fn,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(res.mode).toBe('cli');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** Замокать fetch с заданным JSON-ответом. */
function okFetch(payload: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })) as unknown as typeof fetch;
}

describe('runAssistant: API по apiKind (fetch мокнут)', () => {
  let dir: string;
  const KEY = 'sk-super-secret-DO-NOT-LEAK-9999';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-run-api-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('anthropic (claude без CLI + ключ) → messages API, ключ в заголовке x-api-key', async () => {
    const claude = getProvider('claude');
    setStoredKey(dir, 'claude', KEY);
    const fetchMock = okFetch({ content: [{ type: 'text', text: 'ответ anthropic' }] });
    const res = await runAssistant(claude, [{ role: 'user', content: 'привет' }], {
      appDataDir: dir,
      detect: noCli,
      fetchImpl: fetchMock,
    });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('api');
    expect(res.reply).toBe('ответ anthropic');
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain('api.anthropic.com');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
  });

  it('openai (codex без CLI + ключ) → chat/completions, Bearer', async () => {
    const codex = getProvider('codex');
    setStoredKey(dir, 'codex', KEY);
    const fetchMock = okFetch({ choices: [{ message: { content: 'ответ openai' } }] });
    const res = await runAssistant(codex, [{ role: 'user', content: 'привет' }], {
      appDataDir: dir,
      detect: noCli,
      fetchImpl: fetchMock,
    });
    expect(res.ok).toBe(true);
    expect(res.reply).toBe('ответ openai');
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain('/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it('google (gemini без CLI + ключ) → generateContent', async () => {
    const gemini = getProvider('gemini');
    setStoredKey(dir, 'gemini', KEY);
    const fetchMock = okFetch({
      candidates: [{ content: { parts: [{ text: 'ответ google' }] } }],
    });
    const res = await runAssistant(gemini, [{ role: 'user', content: 'привет' }], {
      appDataDir: dir,
      detect: noCli,
      fetchImpl: fetchMock,
    });
    expect(res.ok).toBe(true);
    expect(res.reply).toBe('ответ google');
    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain(':generateContent');
  });

  it('ошибка API → структурная, ключ НЕ раскрыт', async () => {
    const codex = getProvider('codex');
    setStoredKey(dir, 'codex', KEY);
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '{"error":"invalid key"}',
    })) as unknown as typeof fetch;
    const res = await runAssistant(codex, [{ role: 'user', content: 'x' }], {
      appDataDir: dir,
      detect: noCli,
      fetchImpl: fetchMock,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('api_error');
    expect(res.error).toContain('401');
    expect(res.error).not.toContain(KEY);
  });
});

describe('runAssistant: none и claude-делегация', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-run-none-'));
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
  });

  it('cursor → none/unsupported, вызова нет', async () => {
    const cursor = getProvider('cursor');
    const fetchMock = vi.fn();
    const spawn = fakeSpawn({ stdout: 'x' });
    const res = await runAssistant(cursor, [{ role: 'user', content: 'x' }], {
      appDataDir: dir,
      detect: yesCli,
      spawnImpl: spawn.fn,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(res.mode).toBe('none');
    expect(res.reason).toBe('unsupported');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawn.calls.length).toBe(0);
  });

  it('gemini без ключа и без CLI → none/no_key_no_cli', async () => {
    const gemini = getProvider('gemini');
    const res = await runAssistant(gemini, [{ role: 'user', content: 'x' }], {
      appDataDir: dir,
      detect: noCli,
    });
    expect(res.mode).toBe('none');
    expect(res.reason).toBe('no_key_no_cli');
  });

  it('claude с CLI → делегирует своему пути (claude -p, промпт в stdin)', async () => {
    const claude = getProvider('claude');
    const spawn = fakeSpawn({ stdout: 'ответ claude' });
    const res = await runAssistant(claude, [{ role: 'user', content: 'вопрос' }], {
      appDataDir: dir,
      detect: yesCli,
      spawnImpl: spawn.fn,
    });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('cli');
    expect(res.experimental).toBe(false); // claude — verified, не experimental
    expect(res.reply).toBe('ответ claude');
    expect(spawn.calls[0]!.args).toContain('-p');
    expect(spawn.stdinChunks.join('')).toContain('вопрос');
  });
});
