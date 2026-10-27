import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * `mr_discussions` MCP хостинга отдаёт `{"items":[…],"pagination":{…}}`: jmespath, написанный под
 * голый массив (`[?notes[?resolvable && !resolved]]`), возвращает `null` — вызов тратит круг до
 * хостинга и ход, следом повтор (25.10 — два `null`, 26.10 — ещё один). Выражение, не называющее ни
 * `items`, ни `pagination`, отклоняется до вызова. Путь настоящий: диспетчер набора `run.mjs pre`
 * отдельным процессом, как его зовёт `hooks.json`.
 */
const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');

function reason(tool_name: string, jmespath?: string): string {
  const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name,
      tool_input: {
        project_id: 'group/app',
        merge_request_iid: '7',
        ...(jmespath === undefined ? {} : { jmespath }),
      },
      session_id: 'kit-mcp-shape',
    }),
    encoding: 'utf8',
    env: { ...process.env, AGENTDECK_SPLIT_CHILD: '', AGENTDECK_KIT_VARIANT: '' },
    timeout: 15_000,
  });
  const text = out.stdout.trim();
  if (!text) return '';
  const hook = (
    JSON.parse(text) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;
  return hook?.permissionDecision === 'deny' ? (hook.permissionDecisionReason ?? '') : '';
}

describe('mcp-shape-guard набора', () => {
  it('выражение под голый массив — отказ с выражением от items', () => {
    for (const expr of [
      '[?notes[?resolvable && !resolved]].{id:id,notes:notes[].{id:id,body:body}}',
      '[].notes[0].body',
      'length(@)',
      '[?lineitems]',
    ]) {
      const why = reason('mcp__gitlab__mr_discussions', expr);
      expect(why, expr).toContain('mcp-shape-guard');
      expect(why, expr).toContain('items[?notes[?resolvable && !resolved]]');
    }
    // Любое имя сервера хостинга и форма имени opencode.
    expect(reason('mcp__gitlab-work__mr_discussions', '[?x]')).toContain('mcp-shape-guard');
    expect(reason('gitlab_mr_discussions', '[?x]')).toContain('mcp-shape-guard');
  });

  it('выражение от items или pagination, вызов без jmespath и другой инструмент — свободны', () => {
    for (const expr of [
      'items[?notes[0].resolved==`false`].id',
      '{n: length(items)}',
      'pagination.total',
    ])
      expect(reason('mcp__gitlab__mr_discussions', expr), expr).toBe('');
    expect(reason('mcp__gitlab__mr_discussions')).toBe('');
    expect(reason('mcp__gitlab__mr_discussions', '  ')).toBe('');
    expect(reason('mcp__gitlab__list_merge_requests', '[?state==`opened`]')).toBe('');
  });
});
