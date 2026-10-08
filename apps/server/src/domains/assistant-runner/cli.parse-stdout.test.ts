import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getProvider } from '../../providers/registry.ts';
import { runAssistant, type RunAssistantDeps } from './assistant-runner.ts';

/**
 * Ассистент форм и структуры идёт тем же `oneShotArgs`, что и чат, — значит, и
 * stdout у него тот же. CLI, отвечающий потоком JSON (Goose `--output-format
 * stream-json`), без `assistant.parseStdout` отдал бы человеку сырые строки
 * событий. Подменён только процесс CLI; stdout — настоящий вывод Goose 1.53.
 */

const stdout = readFileSync(
  fileURLToPath(
    new URL(
      '../../providers/catalog/__fixtures__/goose-1.53-run-stream-json.jsonl',
      import.meta.url,
    ),
  ),
  'utf8',
);

function fakeSpawn(text: string, code: number = 0, stderr = '') {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: () => void; end: () => void; on: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    child.kill = () => child.emit('close', null);
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(text));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    }, 0);
    return child;
  }) as unknown as RunAssistantDeps['spawnImpl'];
}

describe('assistant-runner: разбор stdout одиночного запуска', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-asst-goose-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('goose: поток JSON → текст ответа, без событий инструмента', async () => {
    const result = await runAssistant(getProvider('goose'), [{ role: 'user', content: 'x' }], {
      appDataDir: dir,
      detect: () => true,
      spawnImpl: fakeSpawn(stdout),
    });
    expect(result.ok).toBe(true);
    expect(result.reply).toBe('Сначала проверю. \n\nГотово: файл на месте.');
  });

  it('CLI без разборщика — stdout и есть ответ, как было', async () => {
    const result = await runAssistant(getProvider('qwen'), [{ role: 'user', content: 'x' }], {
      appDataDir: dir,
      detect: () => true,
      spawnImpl: fakeSpawn('{"type":"message"} как есть'),
    });
    expect(result.reply).toBe('{"type":"message"} как есть');
  });

  // gemini 0.62.0 на win32: ход с инструментом, ответ напечатан, событие
  // `result: success` есть — и падение на выходе (0xC0000409). Поток настоящий.
  const geminiStream = readFileSync(
    fileURLToPath(
      new URL(
        '../../providers/catalog/__fixtures__/gemini-0.62-stream-json.jsonl',
        import.meta.url,
      ),
    ),
    'utf8',
  );
  const CRASH = 3221226505;
  const ASSERT = 'Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)';

  it('gemini: CLI сказал «ход удался», потом упал на выходе — ответ принят', async () => {
    const result = await runAssistant(getProvider('gemini'), [{ role: 'user', content: 'x' }], {
      appDataDir: dir,
      detect: () => true,
      spawnImpl: fakeSpawn(geminiStream, CRASH, ASSERT),
    });
    expect(result.ok).toBe(true);
    expect(result.reply).toBe('AFTER_TOOL');
  });

  it('gemini: без `result: success` ненулевой код — сбой, как раньше', async () => {
    const cut = geminiStream
      .split('\n')
      .filter((line) => !line.includes('"type":"result"'))
      .join('\n');
    const result = await runAssistant(getProvider('gemini'), [{ role: 'user', content: 'x' }], {
      appDataDir: dir,
      detect: () => true,
      spawnImpl: fakeSpawn(cut, CRASH, ASSERT),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Assertion failed');
  });
});
