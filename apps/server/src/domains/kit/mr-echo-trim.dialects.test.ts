import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Эхо записи MR в звене группы по диалектам (P-15): `mr-echo-trim` режет эхо форджа только там,
 * где у CLI есть шов подмены вывода. Claude — поле `updatedMCPToolOutput` ответа PostToolUse;
 * OpenCode — прослойка `variants/opencode` правит объект вывода `tool.execute.after` (для MCP —
 * сам ответ сервера `{content:[…]}`, имя `<сервер>_<инструмент>`). Qwen 0.24 и Codex 0.155 поля
 * не знают — диспетчер его им не шлёт. Живое доказательство OpenCode —
 * `tools/qa/check-mr-echo-trim-opencode.mjs`; здесь настоящий диспетчер и настоящая прослойка,
 * заглушен только сам OpenCode (объекты — формы выпуска 1.18.35).
 */

const KIT = builtinKitDir();
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const SHIM = resolve(KIT, '..', 'variants', 'opencode', 'plugins', 'agentdeck-kit.js');
const dir = mkdtempSync(join(tmpdir(), 'kit-mr-echo-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DESCRIPTION = 'Описание MR. '.repeat(400);
const ECHO = JSON.stringify({
  id: 9001,
  iid: 7,
  title: 'feat: x',
  state: 'opened',
  web_url: 'https://forge.example.com/group/proj/-/merge_requests/7',
  source_branch: 'feature/x',
  target_branch: 'main',
  description: DESCRIPTION,
});

const ENV_KEYS = [
  'AGENTDECK_KIT_DIR',
  'AGENTDECK_SPLIT_CHILD',
  'AGENTDECK_KIT_STATE',
  'AGENTDECK_KIT_VARIANT',
  'AGENTDECK_HEAVY_QUEUE_DIR',
  'AGENTDECK_KIT_CLI',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function dispatch(cli: string, payload: object, child: boolean): Record<string, unknown> {
  const out = spawnSync(process.execPath, [DISPATCH, 'post-any', `--cli=${cli}`], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      AGENTDECK_KIT_CLI: '',
      AGENTDECK_KIT_STATE: join(dir, 'state'),
      AGENTDECK_SPLIT_CHILD: child ? '1' : '',
    },
    timeout: 15_000,
  }).stdout.trim();
  return out ? (JSON.parse(out) as Record<string, unknown>) : {};
}

const forgeCall = (tool: string) => ({
  hook_event_name: 'PostToolUse',
  session_id: 's1',
  cwd: dir,
  tool_name: tool,
  tool_input: { iid: '7', description: DESCRIPTION },
  tool_response: [{ type: 'text', text: ECHO }],
});

type AfterHook = (input: object, output: Record<string, unknown>) => Promise<void>;

async function shimAfter(): Promise<AfterHook> {
  // Прослойка читает путь набора при загрузке, как в OpenCode, — до импорта.
  process.env.AGENTDECK_KIT_DIR = KIT;
  const mod = (await import(pathToFileURL(SHIM).href)) as Record<
    string,
    (ctx: { directory: string }) => Promise<Record<string, AfterHook>>
  >;
  const hooks = await Object.values(mod)[0]!({ directory: dir });
  return hooks['tool.execute.after']!;
}

function shimEnv(child: boolean): void {
  process.env.AGENTDECK_KIT_DIR = KIT;
  process.env.AGENTDECK_SPLIT_CHILD = child ? '1' : '';
  process.env.AGENTDECK_KIT_STATE = join(dir, 'state');
  process.env.AGENTDECK_KIT_VARIANT = '';
  process.env.AGENTDECK_HEAVY_QUEUE_DIR = '';
  process.env.AGENTDECK_KIT_CLI = '';
}

const textOf = (output: Record<string, unknown>): string =>
  (output.content as { text?: string }[]).map((part) => part.text ?? '').join('\n');

describe('mr-echo-trim по диалектам (P-15)', () => {
  it('Claude: звено группы получает короткое эхо полем updatedMCPToolOutput', () => {
    const out = dispatch('claude', forgeCall('mcp__forge__update_merge_request'), true);
    const hook = out.hookSpecificOutput as { updatedMCPToolOutput?: { text: string }[] };
    expect(hook?.updatedMCPToolOutput?.[0]?.text).toContain(
      `"description_chars":${DESCRIPTION.length}`,
    );
  });

  it('Qwen и Codex: поля подмены нет у CLI — диспетчер его не шлёт', () => {
    for (const cli of ['qwen', 'codex']) {
      const out = dispatch(cli, forgeCall('mcp__forge__update_merge_request'), true);
      expect(JSON.stringify(out)).not.toContain('updatedMCPToolOutput');
    }
  });

  it(
    'OpenCode: прослойка режет эхо MCP в объекте вывода, человеку — целиком',
    { timeout: 60_000 },
    async () => {
      const after = await shimAfter();
      const call = { tool: 'forge_update_merge_request', sessionID: 's1', callID: 'c1', args: {} };
      shimEnv(true);
      const group: Record<string, unknown> = { content: [{ type: 'text', text: ECHO }] };
      await after(call, group);
      const cut = textOf(group);
      expect(cut.length).toBeLessThan(1_200);
      expect(cut).toContain('"iid":7');
      expect(cut).toContain('merge_requests/7');
      expect(cut).toContain(`"description_chars":${DESCRIPTION.length}`);
      expect(cut).not.toContain('Описание MR.');

      shimEnv(false);
      const human: Record<string, unknown> = { content: [{ type: 'text', text: ECHO }] };
      await after(call, human);
      expect(textOf(human)).toBe(ECHO);

      // Ответ с ошибкой и встроенный инструмент — не трогаются.
      shimEnv(true);
      const failed: Record<string, unknown> = {
        content: [{ type: 'text', text: ECHO }],
        isError: true,
      };
      await after(call, failed);
      expect(textOf(failed)).toBe(ECHO);
      const bash: Record<string, unknown> = { output: ECHO, title: 'bash', metadata: {} };
      await after({ ...call, tool: 'bash' }, bash);
      expect(bash.output).toBe(ECHO);
    },
  );
});
