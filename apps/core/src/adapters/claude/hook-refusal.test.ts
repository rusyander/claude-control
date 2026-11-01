import { describe, expect, it } from 'vitest';
import type { AdapterEvent } from '../adapter.types.ts';
import { SdkNormaliser } from '../sdk-stream/normalise.ts';
import { readClaudeHookRefusals, type HookReaderContext } from './hook-refusal.ts';
import { mapClaudePermission } from './permission.ts';

/**
 * Отказы хуков в потоке Claude Code 2.1.310 (G-e): формы строк — из живых проб Q1-Q3
 * (`layer-probe.live.integration.test.ts` держит их на настоящем CLI). Здесь — чтение и
 * закрытие хода: хук ядра никогда не `hook.refused`, блок UserPromptSubmit не держит насос.
 */

const CORE = '"C:/node.exe" "C:/core/run.ts" hook';
const USER = '"C:/node.exe" "C:/home/hook.mjs" user';
const CTX: HookReaderContext = {
  coreHook: CORE,
  hooks: [{ key: 'PreToolUse.0.0', command: USER }],
};

const toolDenied = (text: string, id = 'toolu_1') => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] },
  tool_result_meta: [
    { id, permission_decision: { decision: 'reject', source: 'hook', reason_type: 'hook' } },
  ],
});
const promptBlocked = (reason: string) => ({
  type: 'system',
  subtype: 'informational',
  prompt_submit_outcome: { kind: 'blocked_by_hook', prompt_kept: false, reason },
});
const stopFeedback = (reason: string) => ({
  type: 'user',
  isSynthetic: true,
  message: { content: [{ type: 'text', text: `Stop hook feedback:\n${reason}` }] },
});

describe('readClaudeHookRefusals', () => {
  it('PreToolUse exit 2 of a known user hook names its inventory key', () => {
    expect(
      readClaudeHookRefusals(toolDenied(`PreToolUse:Read hook error: [${USER}]: no reads`), CTX),
    ).toEqual([
      { toolUseId: 'toolu_1', event: 'PreToolUse', hook: 'PreToolUse.0.0', reason: 'no reads' },
    ]);
  });

  it('PreToolUse JSON deny carries no command: hook stays null', () => {
    expect(
      readClaudeHookRefusals(toolDenied('PreToolUse:Read hook error: json said no'), CTX),
    ).toEqual([{ toolUseId: 'toolu_1', event: 'PreToolUse', hook: null, reason: 'json said no' }]);
  });

  it('the core hook refusal is never a user hook refusal', () => {
    const line = toolDenied(`PreToolUse:Bash hook error: [${CORE}]: agentdeck: denied by rule`);
    expect(readClaudeHookRefusals(line, CTX)).toEqual([]);
    expect(readClaudeHookRefusals(promptBlocked(`[${CORE}]: agentdeck: x`), CTX)).toEqual([]);
    expect(readClaudeHookRefusals(stopFeedback(`[${CORE}]: agentdeck: x`), CTX)).toEqual([]);
  });

  it('without a known core command (reattach) the core is recognised by its stderr', () => {
    const ctx: HookReaderContext = { hooks: [] };
    const core = toolDenied('PreToolUse:Bash hook error: [old core cmd]: agentdeck: denied');
    expect(readClaudeHookRefusals(core, ctx)).toEqual([]);
    const user = toolDenied('PreToolUse:Bash hook error: [someone]: blocked');
    expect(readClaudeHookRefusals(user, ctx)).toEqual([
      { toolUseId: 'toolu_1', event: 'PreToolUse', hook: null, reason: 'blocked' },
    ]);
  });

  it('a tool error without hook meta is not a refusal', () => {
    const line = toolDenied('PreToolUse:Read hook error: x');
    line.tool_result_meta = [];
    expect(readClaudeHookRefusals(line, CTX)).toEqual([]);
  });

  it('UserPromptSubmit block and Stop feedback are read; Stop is cli-initiated', () => {
    expect(readClaudeHookRefusals(promptBlocked('UPS_BLOCK_REASON'), CTX)).toEqual([
      { toolUseId: null, event: 'UserPromptSubmit', hook: null, reason: 'UPS_BLOCK_REASON' },
    ]);
    expect(readClaudeHookRefusals(stopFeedback('STOP_BLOCK_REASON 0'), CTX)).toEqual([
      {
        toolUseId: null,
        event: 'Stop',
        hook: null,
        reason: 'STOP_BLOCK_REASON 0',
        cliInitiated: true,
      },
    ]);
  });
});

describe('normaliser with the Claude hook reader', () => {
  const rule = {
    echo: true,
    mapPermission: mapClaudePermission,
    hookRefusals: (line: Record<string, unknown>) => readClaudeHookRefusals(line, CTX),
  };
  const feed = (n: SdkNormaliser, ...lines: object[]): AdapterEvent[] =>
    lines.flatMap((l) => n.push(JSON.stringify(l)));

  it('a blocked prompt (never echoed) opens and ends its send turn on result', () => {
    const n = new SdkNormaliser(rule);
    n.expect('cmd-1', 'u-1');
    const events = feed(n, promptBlocked('UPS_BLOCK_REASON'), {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 0,
      result: '',
    });
    expect(events.map((e) => e.type)).toEqual(['turn.started', 'hook.refused', 'turn.ended']);
    expect(events[0]).toMatchObject({ attribution: 'cmd-1', origin: 'sequence' });
    expect(events[1]).toMatchObject({ event: 'UserPromptSubmit', cliInitiated: false });
    expect(events[2]).toMatchObject({ attribution: 'cmd-1' });
  });

  it('a user-hook tool denial yields tool.result then hook.refused; the core one only tool.result', () => {
    const n = new SdkNormaliser(rule);
    n.expect('cmd-1', 'u-1');
    feed(n, { type: 'user', isReplay: true, uuid: 'u-1', message: { content: 'go' } });
    const user = feed(n, toolDenied(`PreToolUse:Read hook error: [${USER}]: no`));
    expect(user.map((e) => e.type)).toEqual(['tool.result', 'hook.refused']);
    expect(user[1]).toMatchObject({ hook: 'PreToolUse.0.0', cliInitiated: false });
    const core = feed(n, toolDenied(`PreToolUse:Bash hook error: [${CORE}]: agentdeck: no`, 't2'));
    expect(core.map((e) => e.type)).toEqual(['tool.result']);
  });
});
