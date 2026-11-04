import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kimiRunFacts } from '@agentdeck/providers/kimi';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { afterAll, describe, expect, it } from 'vitest';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { liveRoot } from '../conformance/__fixtures__/live.ts';

/**
 * Живой Kimi Code над `openai-chat` общей заглушки (этап 10, образ `--clis` у
 * `tools/core-linux.mjs`; без kimi — пропуск). Адрес модели едет КАНАЛОМ из фактов запуска
 * (`kimiRunFacts.channels[0].build` — те же переменные `KIMI_MODEL_*`, что поставит ядро):
 * доказано, что канал действует на настоящем CLI, а провод заглушки он разбирает — вызов
 * инструмента чтения, ответ инструмента, итоговый текст в потоке `-p --output-format
 * stream-json`. Дом CLI — временный `KIMI_CODE_HOME`, ключ — строка-заглушка.
 */

const present = hasCli(kimiRunFacts.binary.command);
const live = liveRoot('kimi-wire-');
const MARK = `FILE_MARK_${Math.random().toString(36).slice(2, 8)}`;
let stub: StubModel | undefined;

afterAll(async () => {
  await stub?.close();
  rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

interface KimiLine {
  role?: string;
  content?: unknown;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(kimiRunFacts.binary.command, args, {
      cwd,
      env,
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const text = (content: unknown): string =>
  typeof content === 'string' ? content : JSON.stringify(content ?? '');

describe.skipIf(!present)('kimi over the openai-chat stub through its run channel (live)', () => {
  it('the KIMI_MODEL_* channel reaches the stub; a read tool call and its result round-trip', async () => {
    const home = join(live.home, '.kimi-code');
    mkdirSync(home, { recursive: true });
    const file = join(live.cwd, 'hello.txt');
    writeFileSync(file, `${MARK}\n`);
    let readTool = '';
    stub = await startStubModel({
      models: ['stub-chat'],
      script: ({ request, info }) => {
        // Kimi Code 2.4 зовёт чтение `Read` (как Claude Code), старый kimi-cli — `ReadFile`.
        const read = info.tools.find((tool) => /^read(_?file)?$/i.test(tool.name));
        if (read && !info.hasToolResult) {
          readTool = read.name;
          const required = (read.schema as { required?: string[] } | undefined)?.required ?? [];
          return {
            tool: { name: read.name, args: { [required[0] ?? 'path']: file } },
            usage: { input: 7, output: 3 },
          };
        }
        return {
          text: request.raw.includes(MARK) ? 'SAW_MARK' : 'NO_MARK',
          usage: { input: 11, output: 2 },
        };
      },
    });
    const channel = kimiRunFacts.channels[0]!;
    if (channel.via !== 'env' || channel.form !== 'run') throw new Error('kimi channel moved');
    const channelEnv = channel.build({
      baseUrl: `${stub.baseUrl.replace(/\/+$/, '')}/v1`,
      model: 'stub-chat',
      key: 'stub-key',
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: live.home,
      KIMI_CODE_HOME: home,
      KIMI_DISABLE_TELEMETRY: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      ...channelEnv,
    };
    const out = await run(
      ['-p', 'Read hello.txt and tell me what it says', '--output-format', 'stream-json'],
      env,
      live.cwd,
    );
    const lines = out.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as KimiLine);
    const detail = `exit ${out.code}\n${out.stdout.slice(0, 2000)}\n${out.stderr.slice(-2000)}`;
    expect(readTool, `tools offered: ${stub.requests[0]?.tools.join(',')}`).not.toBe('');
    expect(stub.requests.length, detail).toBeGreaterThanOrEqual(2);
    expect(stub.requests.every((r) => r.dialect === 'openai-chat')).toBe(true);
    const call = lines.flatMap((line) => line.tool_calls ?? []).find((c) => c.function?.name);
    expect(call?.function?.name, detail).toBe(readTool);
    expect(call?.function?.arguments ?? '').toContain('hello.txt');
    const toolLine = lines.find((line) => line.role === 'tool');
    expect(text(toolLine?.content), detail).toContain(MARK);
    expect(stub.requests.at(-1)?.hasToolResult).toBe(true);
    const reply = lines
      .filter((line) => line.role === 'assistant')
      .map((line) => text(line.content))
      .join('');
    expect(reply, detail).toContain('SAW_MARK');
    expect(out.code, detail).toBe(0);
  }, 180_000);
});
