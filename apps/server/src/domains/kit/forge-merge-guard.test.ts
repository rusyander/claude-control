import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Слияние MR/PR — дело человека, без двери согласия: `git merge` отказывал
 * git-guard, а слияние запроса через `gh`/`glab`, REST и MCP хостинга проходило
 * (под полным доступом — вовсе без карточки). Проверка — настоящим процессом
 * диспетчера набора, как его зовёт `hooks.json`.
 */
const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');

function verdict(tool_name: string, tool_input: Record<string, unknown>, splitChild = '') {
  const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name,
      tool_input,
      session_id: 'kit-fmg',
    }),
    encoding: 'utf8',
    env: { ...process.env, AGENTDECK_SPLIT_CHILD: splitChild, AGENTDECK_KIT_VARIANT: '' },
    timeout: 15_000,
  });
  const text = out.stdout.trim();
  if (!text) return undefined;
  const hook = (
    JSON.parse(text) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;
  return hook?.permissionDecision ? hook : undefined;
}

describe('forge-merge-guard набора', () => {
  it('слияние запроса — отказ: CLI, REST под PUT, MCP хостинга', () => {
    for (const command of [
      'gh pr merge 5 --squash',
      'glab mr merge 12',
      'curl -X PUT "https://gitlab.example.com/api/v4/projects/1/merge_requests/5/merge"',
    ]) {
      const out = verdict('Bash', { command });
      expect(out?.permissionDecision, command).toBe('deny');
      expect(out?.permissionDecisionReason).toContain('forge-merge-guard');
    }
    expect(
      verdict('mcp__gitlab__merge_merge_request', { merge_request_iid: 5 })?.permissionDecision,
    ).toBe('deny');
  });

  it('чтение, создание и текст о слиянии — свободны', () => {
    for (const command of [
      'gh pr view 5',
      'gh api repos/o/r/pulls/5/merge',
      'echo "gh pr merge needs the owner"',
    ]) {
      expect(verdict('Bash', { command })?.permissionDecisionReason ?? '', command).not.toContain(
        'forge-merge-guard',
      );
    }
    expect(verdict('mcp__gitlab__get_merge_request', { merge_request_iid: 5 })).toBeUndefined();
  });

  it('слияние инструментом MCP в форме opencode (`<сервер>_<инструмент>`) — тоже отказ', () => {
    expect(
      verdict('gitlab_merge_merge_request', { merge_request_iid: 5 })?.permissionDecision,
    ).toBe('deny');
  });

  it('одобрение MR — отказ только в группе: MCP, opencode, glab, gh, REST под POST', () => {
    const approves: [string, Record<string, unknown>][] = [
      ['mcp__gitlab__approve_merge_request', { merge_request_iid: 5 }],
      ['gitlab_approve_merge_request', { merge_request_iid: 5 }],
      ['Bash', { command: 'glab mr approve 12' }],
      ['Bash', { command: 'gh pr review 5 --approve' }],
      [
        'Bash',
        {
          command:
            'curl -X POST "https://gitlab.example.com/api/v4/projects/1/merge_requests/5/approve"',
        },
      ],
    ];
    for (const [tool, input] of approves) {
      const inGroup = verdict(tool, input, '1');
      expect(inGroup?.permissionDecision, JSON.stringify(input)).toBe('deny');
      expect(inGroup?.permissionDecisionReason).toContain('approves a request');
      expect(
        verdict(tool, input)?.permissionDecisionReason ?? '',
        JSON.stringify(input),
      ).not.toContain('approves a request');
    }
    expect(
      verdict('mcp__gitlab__unapprove_merge_request', { merge_request_iid: 5 }, '1')
        ?.permissionDecisionReason ?? '',
    ).not.toContain('forge-merge-guard');
  });
});
