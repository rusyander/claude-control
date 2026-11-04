import { describe, expect, it } from 'vitest';
import { platformDenySet } from '../deny-overlay.ts';
import type { DenySet, SessionSpec } from '../adapter.types.ts';
import {
  bindGeminiEndpoint,
  checkGeminiSession,
  commandWordsRegex,
  fillGeminiInput,
  GEMINI_CHANNELS,
  GEMINI_FILES,
  geminiPolicyToml,
  mapGeminiPermission,
  planGemini,
  refuseGemini,
} from './index.ts';

/**
 * Gemini CLI 0.66 без живого CLI: оверлей запретов сверяется ТЕМ ЖЕ способом, что у CLI (бандл
 * 0.66, `policy/toml-loader` + `policy/utils`): правило по словам — `"command":"<regex>` над
 * `stableStringify` аргументов, а регулярное выражение с «вложенным повтором» CLI отбрасывает
 * (`isSafeRegExp`) — отброшенное правило ничего не закрывает, поэтому проверка повторена здесь.
 */

/** `isSafeRegExp` Gemini CLI 0.66 дословно: правило, не прошедшее её, CLI молча не грузит. */
function geminiAccepts(pattern: string): boolean {
  try {
    new RegExp(pattern);
  } catch {
    return false;
  }
  if (pattern.length > 2048) return false;
  return !/\([^)]*[*+?{].*\)[*+?{]/.test(pattern);
}

/** Правило по словам так, как его применяет CLI: `"command":"` + выражение над JSON аргументов. */
const denies = (regex: string, command: string): boolean =>
  new RegExp(`"command":"${regex}`).test(JSON.stringify({ command }));

const DENY: DenySet = {
  ...platformDenySet({
    coreHome: '/home/u/.agentdeck',
    tokenFiles: ['/home/u/.agentdeck/api-token'],
  }),
  editPaths: ['/work/copy/.git'],
  tools: [],
};

describe('gemini deny policy (overlay of the core deny set)', () => {
  const toml = geminiPolicyToml(DENY);
  const regexes = [...toml.matchAll(/commandRegex = ("(?:[^"\\]|\\.)*")/g)].map(
    (m) => JSON.parse(m[1]!) as string,
  );
  const argsPatterns = [...toml.matchAll(/argsPattern = ("(?:[^"\\]|\\.)*")/g)].map(
    (m) => JSON.parse(m[1]!) as string,
  );

  it('every publish command gets a prefix rule and a words rule, all deny at top priority', () => {
    for (const argv of DENY.commands) {
      expect(toml).toContain(`commandPrefix = ${JSON.stringify(argv.join(' '))}`);
      expect(regexes).toContain(commandWordsRegex(argv));
    }
    const rules = toml.split('[[rule]]').slice(1);
    expect(rules.length).toBeGreaterThan(DENY.commands.length * 2);
    for (const rule of rules) {
      expect(rule).toContain('decision = "deny"');
      expect(rule).toContain('priority = 999');
    }
  });

  it('every regex survives the CLI ReDoS filter (a dropped rule closes nothing)', () => {
    for (const r of [...regexes.map((x) => `"command":"${x}`), ...argsPatterns]) {
      expect(geminiAccepts(r), r).toBe(true);
    }
    // Проба 02.11: группа с повтором — правило отброшено, `env git push` прошёл.
    expect(geminiAccepts('"command":"(?:[^"\\\\]|\\\\.)*git')).toBe(false);
  });

  it('the push words rule closes env/chained/path forms and leaves git status and pushd alone', () => {
    const push = commandWordsRegex(['git', 'push']);
    for (const c of [
      'git push origin main',
      'env git push origin main',
      'cd . && git push',
      '/usr/bin/git push',
      'git -C ../x push --force',
    ])
      expect(denies(push, c), c).toBe(true);
    for (const c of ['git status', 'git pushd', 'legit push', 'git log --grep=pushed'])
      expect(denies(push, c), c).toBe(false);
    const setUrl = commandWordsRegex(['git', 'remote', 'set-url', '--push']);
    expect(denies(setUrl, 'git remote set-url --push origin x')).toBe(true);
    expect(denies(setUrl, 'git remote set-url origin x')).toBe(false);
  });

  it('closed paths: file tools by their path argument, the shell by the path in its command', () => {
    const tokenRead = JSON.stringify({ file_path: '/home/u/.agentdeck/api-token' });
    expect(argsPatterns.some((p) => new RegExp(p).test(tokenRead))).toBe(true);
    const dirList = JSON.stringify({ dir_path: '/home/u/.agentdeck' });
    expect(argsPatterns.some((p) => new RegExp(p).test(dirList))).toBe(true);
    expect(regexes.some((r) => denies(r, 'cat /home/u/.agentdeck/api-token'))).toBe(true);
    const gitEdit = JSON.stringify({ file_path: '/work/copy/.git/hooks/pre-push' });
    expect(argsPatterns.some((p) => new RegExp(p).test(gitEdit))).toBe(true);
    const plainRead = JSON.stringify({ file_path: '/work/copy/src/a.ts' });
    expect(argsPatterns.some((p) => new RegExp(p).test(plainRead))).toBe(false);
  });

  it('a read-only step closes the write, edit, shell and web tools by name', () => {
    const toml2 = geminiPolicyToml({ ...DENY, tools: ['write', 'edit', 'shell', 'web'] });
    for (const tool of [
      'write_file',
      'replace',
      'run_shell_command',
      'web_fetch',
      'google_web_search',
    ])
      expect(toml2).toMatch(
        new RegExp(`\\[\\[rule\\]\\]\\ntoolName = "${tool}"\\ndecision = "deny"`),
      );
  });
});

describe('gemini call vocabulary over ACP (no rawInput)', () => {
  it('input is rebuilt from the line: shell from title, files from the diff or location path', () => {
    expect(
      fillGeminiInput({ toolCallId: 'run_shell_command__call_1', title: 'git push origin main' }),
    ).toEqual({ command: 'git push origin main' });
    expect(
      fillGeminiInput({
        toolCallId: 'write_file__call_2',
        title: 'a.txt',
        content: [{ type: 'diff', path: '/w/a.txt', oldText: '', newText: 'x' }],
      }),
    ).toEqual({ file_path: '/w/a.txt' });
    expect(
      fillGeminiInput({ toolCallId: 'list_directory__c', locations: [{ path: '/w' }] }),
    ).toEqual({ dir_path: '/w' });
    expect(fillGeminiInput({ toolCallId: 'read_file__c', title: 'a.txt' })).toBeNull();
  });

  it('asks map to the core vocabulary; a path-less file call is "other", never a read of nothing', () => {
    expect(
      mapGeminiPermission({ tool: 'run_shell_command', input: { command: 'git status' } }),
    ).toMatchObject({ action: 'exec', argv: ['git', 'status'], argvExact: true });
    expect(
      mapGeminiPermission({ tool: 'run_shell_command', input: { command: 'echo $(git push)' } }),
    ).toMatchObject({ action: 'exec', argvExact: false });
    expect(mapGeminiPermission({ tool: 'replace', input: { file_path: '/w/a' } })).toMatchObject({
      action: 'edit',
      target: '/w/a',
    });
    expect(mapGeminiPermission({ tool: 'write_file', input: {} })).toMatchObject({
      action: 'other',
    });
    expect(mapGeminiPermission({ tool: 'web_fetch', input: { prompt: 'x' } })).toMatchObject({
      action: 'net',
    });
  });
});

describe('gemini launch facts', () => {
  const endpoint = {
    baseUrl: 'http://127.0.0.1:9/',
    dialect: 'google-genai' as const,
    model: 'stub-model',
    key: 'stub-key',
  };

  it('binds the google-genai endpoint by env only, refuses another dialect', () => {
    expect(bindGeminiEndpoint(GEMINI_CHANNELS[0]!, endpoint)).toEqual({
      ok: true,
      binding: {
        env: {
          GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9',
          GEMINI_MODEL: 'stub-model',
          GEMINI_API_KEY: 'stub-key',
        },
        argv: [],
        files: {},
      },
    });
    expect(
      bindGeminiEndpoint(GEMINI_CHANNELS[0]!, { ...endpoint, dialect: 'openai-chat' }),
    ).toEqual({ ok: false, code: 'no_channel' });
  });

  it('plan: own home inside the session dir, untrusted copy, settings and policy files', () => {
    const spec = {
      dir: '/s/1',
      deny: DENY,
      mcpServers: { x: {} },
    } as unknown as SessionSpec;
    const plan = planGemini(spec, null, {} as never);
    expect(plan.args).toEqual(['--acp']);
    expect(plan.env.GEMINI_CLI_HOME?.replace(/\\/g, '/')).toBe('/s/1/gemini-home');
    expect(plan.env.GEMINI_CLI_TRUST_WORKSPACE).toBe('false');
    expect(JSON.parse(plan.files[GEMINI_FILES.settings]!)).toEqual({
      security: { auth: { selectedType: 'gemini-api-key' } },
    });
    expect(plan.files[GEMINI_FILES.policy]).toContain('commandPrefix = "git push"');
    expect(Object.keys(plan.files).every((f) => f.startsWith('gemini-home/'))).toBe(true);
    expect(plan.layerLosses).toEqual([
      'mcp servers not carried (gemini 0.66 starts no mcp server in an untrusted folder, stdio or remote, and the copy is untrusted): x',
    ]);
  });

  it('handshake: any mode but default fails the launch; no endpoint is refused, resume goes to the transcript court', () => {
    expect(checkGeminiSession({ modes: { currentModeId: 'default' } })).toBeNull();
    expect(checkGeminiSession({ modes: { currentModeId: 'yolo' } })).toMatch(/expected default/);
    expect(refuseGemini({} as SessionSpec)).toMatch(/routed endpoint/);
    // Продолжение судит `geminiResume` (id + корень, transcript.test.ts), не общий отказ.
    expect(
      refuseGemini({
        endpoint: { channel: GEMINI_CHANNELS[0]!, endpoint },
        resume: { conversationId: 'x' },
      } as never),
    ).toBeNull();
  });
});
