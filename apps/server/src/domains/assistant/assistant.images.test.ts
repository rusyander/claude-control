import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { askAssistant } from './assistant.ts';

/**
 * Помощник формы (`/api/assist`) с картинкой (12b): настоящий запуск процесса,
 * фальшивый `claude`, снимающий свой argv и stdin. С картинкой — потоковый ввод
 * и итог из события `result` (ответ помощника — JSON с полями формы); без
 * картинки — прежний `--output-format json` байт в байт.
 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const isWindows = process.platform === 'win32';

const FAKE = `
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
writeFileSync(new URL('./dump.json', import.meta.url), JSON.stringify({ argv, stdin: Buffer.concat(chunks).toString('utf8') }));
const answer = JSON.stringify({ reply: 'Заполнил по снимку.', fields: { name: 'from-shot' } });
if (argv.includes('--input-format')) {
  process.stdout.write(JSON.stringify({ type: 'system' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: answer, session_id: 'sess-9' }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ result: answer, session_id: 'sess-1' }));
}
`;

describe('askAssistant: картинка', () => {
  let dir: string;
  let command: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-assist-images-'));
    const script = join(dir, 'fake-claude.mjs');
    writeFileSync(script, FAKE, 'utf8');
    if (isWindows) {
      command = join(dir, 'claude.cmd');
      writeFileSync(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    } else {
      command = join(dir, 'claude');
      writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
        mode: 0o755,
      });
    }
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const dump = (): { argv: string[]; stdin: string } =>
    JSON.parse(readFileSync(join(dir, 'dump.json'), 'utf8')) as { argv: string[]; stdin: string };

  it('картинка — блоком image потокового ввода; поля формы из события result', async () => {
    const response = await askAssistant(
      {
        kind: 'rule',
        message: 'заполни по снимку',
        fields: {},
        schema: { name: 'имя' },
        images: [{ name: 'shot.png', mediaType: 'image/png', base64: PNG }],
      },
      command,
    );
    expect(response).toMatchObject({
      reply: 'Заполнил по снимку.',
      fields: { name: 'from-shot' },
    });
    const seen = dump();
    expect(seen.argv).toContain('--input-format');
    const line = JSON.parse(seen.stdin.trim()) as {
      message: { content: Array<Record<string, unknown>> };
    };
    expect(line.message.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG },
    });
    expect(String(line.message.content[1]!.text)).toContain('заполни по снимку');
  });

  it('без картинки — прежний запуск: JSON-конверт, текст в stdin', async () => {
    const response = await askAssistant(
      { kind: 'rule', message: 'просто так', fields: {}, schema: { name: 'имя' } },
      command,
    );
    expect(response).toMatchObject({ fields: { name: 'from-shot' } });
    // Сессии у помощника нет (лёгкое окно): id из конверта наружу не идёт.
    expect(response).not.toHaveProperty('sessionId');
    const seen = dump();
    expect(seen.argv).not.toContain('--input-format');
    expect(seen.stdin).toContain('просто так');
    expect(() => JSON.parse(seen.stdin)).toThrow();
  });
});
