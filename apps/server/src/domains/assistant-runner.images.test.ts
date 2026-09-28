import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../providers/registry.ts';
import { setStoredKey } from '../lib/provider-keys.ts';
import { runAssistant, type RunAssistantDeps } from './assistant-runner.ts';
import type { AssistantMessage } from './assistant-runner/types.ts';
import { flattenPrompt, withImagePaths } from './assistant-runner/cli.ts';

/**
 * Картинка в запросе ассистента (12b): помощник формы и ассистент шага группы
 * идут через этот раннер, и картинка обязана дойти до модели в форме КАЖДОГО
 * получателя — потоковым вводом `claude`, частями трёх API, файлом чужому CLI.
 * Сеть и процессы подменены; проверяется то, что ушло бы наружу.
 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const image = { name: 'shot.png', mediaType: 'image/png' as const, base64: PNG };
const messages: AssistantMessage[] = [
  { role: 'user', content: 'первый круг' },
  { role: 'assistant', content: 'ответ' },
  { role: 'user', content: 'что на снимке?', images: [image] },
];

function fakeSpawn(stdout: string, onSpawn?: (args: string[], options?: { cwd?: string }) => void) {
  const calls: string[][] = [];
  const stdin: string[] = [];
  const fn = ((_cmd: string, args: string[], options?: { cwd?: string }) => {
    calls.push(args);
    onSpawn?.(args, options);
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: (c: string) => void; end: () => void; on: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: (c: string) => stdin.push(c), end: () => {}, on: () => {} };
    child.kill = () => child.emit('close', null);
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', 0);
    }, 0);
    return child;
  }) as unknown as RunAssistantDeps['spawnImpl'];
  return { fn, calls, stdin };
}

function okFetch(payload: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })) as unknown as typeof fetch;
}

const bodyOf = (fetchMock: typeof fetch): { messages?: unknown; contents?: unknown } => {
  const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
  return JSON.parse(String((init as RequestInit).body)) as { messages?: unknown };
};

describe('runAssistant: картинка доходит до модели', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-run-images-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('claude CLI: потоковый ввод с блоком image, ответ — из события result', async () => {
    const result = JSON.stringify({ type: 'result', is_error: false, result: 'На снимке кнопка.' });
    const spawn = fakeSpawn(`${JSON.stringify({ type: 'system' })}\n${result}\n`);
    const res = await runAssistant(getProvider('claude'), messages, {
      appDataDir: dir,
      detect: () => true,
      spawnImpl: spawn.fn,
    });
    expect(res).toMatchObject({ ok: true, mode: 'cli', reply: 'На снимке кнопка.' });
    const argv = spawn.calls[0]!.join(' ');
    expect(argv).toContain('--input-format');
    expect(argv).toContain('stream-json');
    const line = JSON.parse(spawn.stdin.join('')) as {
      message: { content: Array<Record<string, unknown>> };
    };
    expect(line.message.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG },
    });
    // История целиком — текстом рядом с картинкой, как у обычного хода.
    expect(String(line.message.content[1]!.text)).toContain('Assistant: ответ');
  });

  it('claude CLI: ошибка в событии result — отказ с её текстом, не пустой ответ', async () => {
    const spawn = fakeSpawn(
      `${JSON.stringify({ type: 'result', is_error: true, result: 'Image too large' })}\n`,
    );
    const res = await runAssistant(getProvider('claude'), messages, {
      appDataDir: dir,
      detect: () => true,
      spawnImpl: spawn.fn,
    });
    expect(res).toMatchObject({ ok: false, error: 'Image too large' });
  });

  it('claude без картинки — прежний запуск: текст в stdin, без потокового ввода', async () => {
    const spawn = fakeSpawn('просто ответ');
    const res = await runAssistant(getProvider('claude'), [{ role: 'user', content: 'x' }], {
      appDataDir: dir,
      detect: () => true,
      spawnImpl: spawn.fn,
    });
    expect(res).toMatchObject({ ok: true, reply: 'просто ответ' });
    expect(spawn.calls[0]!.join(' ')).not.toContain('--input-format');
    expect(spawn.stdin.join('')).toBe('x');
  });

  it('API Anthropic: картинка блоком перед текстом, прежние реплики строкой', async () => {
    setStoredKey(dir, 'claude', 'sk-test-key');
    const fetchMock = okFetch({ content: [{ type: 'text', text: 'ок' }] });
    await runAssistant(getProvider('claude'), messages, {
      appDataDir: dir,
      detect: () => false,
      fetchImpl: fetchMock,
    });
    expect(bodyOf(fetchMock).messages).toEqual([
      { role: 'user', content: 'первый круг' },
      { role: 'assistant', content: 'ответ' },
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
          { type: 'text', text: 'что на снимке?' },
        ],
      },
    ]);
  });

  it('OpenAI-совместимый API: image_url с data URI', async () => {
    setStoredKey(dir, 'codex', 'sk-test-key');
    const fetchMock = okFetch({ choices: [{ message: { content: 'ок' } }] });
    await runAssistant(getProvider('codex'), messages, {
      appDataDir: dir,
      detect: () => false,
      fetchImpl: fetchMock,
    });
    const sent = bodyOf(fetchMock).messages as Array<{ content: unknown }>;
    expect(sent[2]!.content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
      { type: 'text', text: 'что на снимке?' },
    ]);
  });

  it('Gemini API: inline_data', async () => {
    setStoredKey(dir, 'gemini', 'g-test-key');
    const fetchMock = okFetch({ candidates: [{ content: { parts: [{ text: 'ок' }] } }] });
    await runAssistant(getProvider('gemini'), messages, {
      appDataDir: dir,
      detect: () => false,
      fetchImpl: fetchMock,
    });
    const contents = bodyOf(fetchMock).contents as Array<{ parts: unknown }>;
    expect(contents[2]!.parts).toEqual([
      { inline_data: { mime_type: 'image/png', data: PNG } },
      { text: 'что на снимке?' },
    ]);
  });

  it('чужой CLI: картинка файлом, путь в тексте, после хода файла нет', async () => {
    let seenPath = '';
    let bytesDuringRun: Buffer | undefined;
    let cwd = '';
    const spawn = fakeSpawn('ок', (args, options) => {
      cwd = options?.cwd ?? '';
      const match = /disk: (\S+image-1\.png)/.exec(args.join(' '));
      seenPath = (match?.[1] ?? '').replace(/["']/g, '');
      if (seenPath && existsSync(seenPath)) bytesDuringRun = readFileSync(seenPath);
    });
    // Одна реплика: многострочный запрос чужой CLI под .cmd на Windows не примет вовсе.
    const single: AssistantMessage[] = [
      { role: 'user', content: 'что на снимке?', images: [image] },
    ];
    const res = await runAssistant(getProvider('gemini'), single, {
      appDataDir: dir,
      detect: () => true,
      spawnImpl: spawn.fn,
    });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    expect(spawn.calls[0]!.join(' ')).toContain('Attached images, read them from disk:');
    expect(bytesDuringRun?.equals(Buffer.from(PNG, 'base64'))).toBe(true);
    expect(existsSync(seenPath)).toBe(false);
    // F-104: Gemini и Qwen читают файлы только внутри рабочей области — картинка
    // в чужой временной папке для них недостижима. Рабочий каталог хода — её папка.
    expect(cwd).not.toBe('');
    expect(relative(cwd, seenPath).startsWith('..')).toBe(false);
  });

  // Ревью 28.09 (F-148): на пути CLI уходили картинки только ПОСЛЕДНЕЙ реплики —
  // на втором ходу модель теряла снимок первого, хотя пути API шлют все ходы.
  const secondTurn: AssistantMessage[] = [
    { role: 'user', content: 'что на снимке?', images: [image] },
    { role: 'assistant', content: 'кнопка' },
    { role: 'user', content: 'а какого она цвета?' },
  ];

  it('claude CLI, второй ход: снимок первого хода снова уходит блоком image', async () => {
    const result = JSON.stringify({ type: 'result', is_error: false, result: 'синяя' });
    const spawn = fakeSpawn(`${result}\n`);
    const res = await runAssistant(getProvider('claude'), secondTurn, {
      appDataDir: dir,
      detect: () => true,
      spawnImpl: spawn.fn,
    });
    expect(res).toMatchObject({ ok: true, reply: 'синяя' });
    const line = JSON.parse(spawn.stdin.join('')) as {
      message: { content: Array<Record<string, unknown>> };
    };
    expect(line.message.content[0]).toMatchObject({ type: 'image' });
  });

  // Многострочный запрос чужой CLI под .cmd на Windows не примет вовсе (см. выше),
  // поэтому текст запроса проверяется на сборщике, который его и формирует.
  it('чужой CLI, второй ход: путь снимка — у той реплики, к которой он приложен', () => {
    const prompt = flattenPrompt(withImagePaths(secondTurn, dir));
    expect(prompt).toContain('что на снимке? (Attached images, read them from disk: ');
    expect(existsSync(join(dir, 'image-1.png'))).toBe(true);
    expect(prompt.endsWith('а какого она цвета?')).toBe(true);
  });
});
