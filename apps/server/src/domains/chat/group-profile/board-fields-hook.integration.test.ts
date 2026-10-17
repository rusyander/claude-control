import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatRunProfile } from './group-profile.ts';

/**
 * Хук списка задач без описаний (5.2 плана экономии) живым процессом, как его
 * зовёт Claude Code: вход JSON на stdin, ответ — JSON на stdout. Поиск и доска
 * трекера без названных полей отдавали каждую задачу с описанием: разбор доски
 * перед разделением вытянул 190 тыс. знаков (замер 16.10).
 */
const HOOK = resolve(__dirname, '../../../../../../tools/board-fields-hook.mjs');
const LIST = 'summary,status,priority,issuetype,assignee,labels,updated';

function hook(input: unknown) {
  const result = spawnSync(process.execPath, [HOOK], {
    input:
      typeof input === 'string'
        ? input
        : JSON.stringify({ hook_event_name: 'PreToolUse', ...(input as object) }),
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

interface Output {
  hookSpecificOutput: {
    hookEventName: string;
    updatedInput: Record<string, unknown>;
    additionalContext: string;
  };
}

describe('board-fields-hook: список задач без описаний', () => {
  it.each([
    ['mcp__tracker__jira_search', { jql: 'project = PROJ', limit: 50 }],
    ['mcp__atlassian-x__jira_get_board_issues', { board_id: '7', jql: 'status != Done' }],
    ['mcp__jira__jira_get_sprint_issues', { sprint_id: '3' }],
  ])('%s без полей — короткий набор, остальной вход как был, подсказка модели', (name, input) => {
    const run = hook({ tool_name: name, tool_input: input });
    expect(run.code, run.err).toBe(0);
    const out = (JSON.parse(run.out) as Output).hookSpecificOutput;
    expect(out.hookEventName).toBe('PreToolUse');
    expect(out.updatedInput).toEqual({ ...input, fields: LIST });
    expect(out.additionalContext).toContain('jira_get_issue');
    expect(out).not.toHaveProperty('permissionDecision');
  });

  it.each([['  '], [[]], [['', ' ']]])(
    'пустые поля %j — подставляется короткий набор',
    (fields) => {
      const run = hook({ tool_name: 'mcp__t__jira_search', tool_input: { jql: 'x', fields } });
      expect(run.out).toContain(`"fields":"${LIST}"`);
    },
  );

  it.each([
    [
      'названные поля',
      { tool_name: 'mcp__t__jira_search', tool_input: { jql: 'x', fields: 'summary,description' } },
    ],
    [
      // Ревью B2-F18: список полей подменялся набором хука.
      'названные поля списком',
      {
        tool_name: 'mcp__t__jira_search',
        tool_input: { jql: 'x', fields: ['summary', 'description'] },
      },
    ],
    [
      'чтение одной задачи',
      { tool_name: 'mcp__t__jira_get_issue', tool_input: { issue_key: 'PROJ-1' } },
    ],
    ['не трекер', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
    ['чужой сервер с похожим именем', { tool_name: 'jira_search', tool_input: { jql: 'x' } }],
    ['вход не объект', { tool_name: 'mcp__t__jira_search', tool_input: ['x'] }],
  ])('%s — вызов как был: тишина и код 0', (_label, input) => {
    const run = hook(input);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toBe('');
  });

  it('битый вход — тишина и код 0: хук не ломает инструмент', () => {
    const run = hook('{not json');
    expect(run.code).toBe(0);
    expect(run.out).toBe('');
  });

  it('матчер профиля и матчер хука — одна строка (повторены в двух местах)', () => {
    const hooks = chatRunProfile({ boardHook: 'x' }).settings.hooks as {
      PreToolUse: { matcher: string }[];
    };
    const matcher = hooks.PreToolUse[0]?.matcher ?? '';
    expect(matcher).toContain('jira_');
    expect(readFileSync(HOOK, 'utf8')).toContain(`'${matcher}'`);
  });
});
