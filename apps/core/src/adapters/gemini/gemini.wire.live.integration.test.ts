import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { geminiRunFacts } from '@agentdeck/providers/gemini';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { afterAll, describe, expect, it } from 'vitest';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { liveRoot } from '../conformance/__fixtures__/live.ts';

/**
 * Живой Gemini CLI над протоколом `google-genai` общей заглушки (этап 10, образ `--clis` у
 * `tools/core-linux.mjs`; на машине без gemini — пропуск с причиной). Доказывает провод, а не
 * переходник: настоящий CLI получает от заглушки вызов `read_file` с аргументами ЦЕЛИКОМ,
 * исполняет его, присылает `functionResponse` с содержимым файла, и итоговый ответ модели
 * доходит до потока CLI; `usageMetadata` последнего кадра становится токенами `result`.
 * Ключи не тратятся: адрес — заглушка, ключ — строка-заглушка, дом CLI — временный.
 */

const present = hasCli(geminiRunFacts.binary.command);
const live = liveRoot('gemini-wire-');
const MARK = `FILE_MARK_${Math.random().toString(36).slice(2, 8)}`;
let stub: StubModel | undefined;

afterAll(async () => {
  await stub?.close();
  rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

interface Line {
  type?: string;
  role?: string;
  content?: string;
  tool_name?: string;
  parameters?: Record<string, unknown>;
  status?: string;
  stats?: { input_tokens?: number; output_tokens?: number };
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(geminiRunFacts.binary.command, args, {
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

describe.skipIf(!present)(`gemini over the google-genai stub (live)`, () => {
  it('functionCall args reach the CLI whole, functionResponse comes back, usage lands in result', async () => {
    const gemini = join(live.home, '.gemini');
    mkdirSync(gemini, { recursive: true });
    writeFileSync(
      join(gemini, 'settings.json'),
      JSON.stringify({
        security: { auth: { selectedType: 'gemini-api-key' } },
        general: { disableAutoUpdate: true, disableUpdateNag: true },
        privacy: { usageStatisticsEnabled: false },
      }),
    );
    const file = join(live.cwd, 'hello.txt');
    writeFileSync(file, `${MARK}\n`);
    stub = await startStubModel({
      models: ['gemini-2.5-flash'],
      script: ({ request, info }) => {
        const read = info.tools.find((tool) => tool.name === 'read_file');
        if (read && !info.hasToolResult) {
          const required = (read.schema as { required?: string[] } | undefined)?.required ?? [];
          return {
            tool: { name: 'read_file', args: { [required[0] ?? 'file_path']: file } },
            usage: { input: 7, output: 3 },
          };
        }
        return {
          text: request.raw.includes(MARK) ? 'SAW_MARK' : 'NO_MARK',
          usage: { input: 11, output: 2 },
        };
      },
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: live.home,
      USERPROFILE: live.home,
      GEMINI_CLI_HOME: live.home,
      GEMINI_API_KEY: 'stub-key',
      GOOGLE_GEMINI_BASE_URL: stub.baseUrl.replace(/\/+$/, ''),
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      NO_COLOR: '1',
    };
    delete env.GOOGLE_API_KEY;
    const out = await run(
      ['-p', 'Read hello.txt', '--output-format', 'stream-json', '-m', 'gemini-2.5-flash'],
      env,
      live.cwd,
    );
    const lines = out.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Line);
    const detail = `exit ${out.code}\n${out.stdout.slice(0, 2000)}\n${out.stderr.slice(-2000)}`;
    expect(stub.requests.length, detail).toBeGreaterThanOrEqual(2);
    expect(stub.requests.every((r) => r.dialect === 'google-genai')).toBe(true);
    expect(stub.requests.some((r) => /:streamGenerateContent/.test(r.path))).toBe(true);
    const use = lines.find((line) => line.type === 'tool_use' && line.tool_name === 'read_file');
    expect(use, detail).toBeDefined();
    expect(Object.values(use?.parameters ?? {})).toContain(file);
    expect(lines.find((line) => line.type === 'tool_result')?.status, detail).toBe('success');
    // Ответ инструмента вернулся заглушке `functionResponse` — модель «увидела» файл.
    expect(stub.requests.at(-1)?.hasToolResult).toBe(true);
    const reply = lines
      .filter((line) => line.type === 'message' && line.role === 'assistant')
      .map((line) => line.content ?? '')
      .join('');
    expect(reply, detail).toContain('SAW_MARK');
    const result = lines.find((line) => line.type === 'result');
    expect(result?.status, detail).toBe('success');
    expect(result?.stats?.input_tokens ?? 0).toBeGreaterThan(0);
    expect(out.code).toBe(0);
  }, 180_000);
});
