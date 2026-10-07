import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProviderApi } from '../../domains/assistant-runner/api.ts';
import { KIMI_READ_ONLY_AGENT, kimiProvider } from './kimi.ts';

const args = kimiProvider.assistant!.oneShotArgs!;

describe('kimi: ключ — только в API Moonshot (D1)', () => {
  const saved = process.env.OPENAI_BASE_URL;
  let dir = '';
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('прямой вызов идёт на api.moonshot.ai, OPENAI_BASE_URL не перехватывает', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-kimi-api-'));
    // Переменная, заведённая человеком для другого инструмента, — ловушка.
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/trap/v1';
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ответ Moonshot' } }] }),
    })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const res = await runProviderApi(kimiProvider, [{ role: 'user', content: 'q' }], 'K-1', {
      appDataDir: dir,
      fetchImpl,
    });
    expect(res).toMatchObject({ ok: true, reply: 'ответ Moonshot' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.moonshot.ai/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer K-1');
  });
});

/** Список `tools:` из frontmatter профиля — тем же видом, что читает Kimi (YAML-список). */
function frontmatterTools(text: string): string[] {
  const head = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? '';
  const block = /^tools:\n((?: {2}- .+\n?)+)/m.exec(head)?.[1] ?? '';
  return block
    .split('\n')
    .map((row) => row.replace(/^ {2}- /, '').trim())
    .filter(Boolean);
}

describe('kimi: «Разрешить правки» в одиночном запуске (D2)', () => {
  it('правки выключены — профиль только для чтения перед `-p`', () => {
    expect(args('P', { allowEdits: false })).toEqual([
      '--agent-file',
      KIMI_READ_ONLY_AGENT,
      '-p',
      'P',
    ]);
  });

  it('правки включены или переключателя нет — argv прежний', () => {
    expect(args('P', { allowEdits: true })).toEqual(['-p', 'P']);
    expect(args('P', {})).toEqual(['-p', 'P']);
    expect(args('P')).toEqual(['-p', 'P']);
  });

  it('профиль лежит рядом и даёт модели одни читающие инструменты', () => {
    expect(existsSync(KIMI_READ_ONLY_AGENT)).toBe(true);
    const text = readFileSync(KIMI_READ_ONLY_AGENT, 'utf8');
    expect(frontmatterTools(text)).toEqual(['Read', 'Glob', 'Grep', 'FetchURL']);
    // Системный промпт Kimi (AGENTS.md, скиллы, плагины) остаётся — профиль его оборачивает.
    expect(text).toContain('${base_prompt}');
    // `description` у профиля обязателен: без него `--agent-file` роняет запуск.
    expect(text).toMatch(/^description: \S/m);
  });

  it('stdout разбирается: оформление стенограммы снято', () => {
    const parser = kimiProvider.assistant!.parseStdout!();
    expect(parser.push('• ответ\n  дальше\n\n') + parser.end()).toBe('ответ\nдальше');
  });
});
