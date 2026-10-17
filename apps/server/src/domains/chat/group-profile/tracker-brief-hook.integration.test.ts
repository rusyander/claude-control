import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Хук свёртки ответов трекера (2.3 плана экономии) живым процессом, как его
 * зовёт Claude Code: вход JSON на stdin, ответ — JSON на stdout. Смена статуса и
 * назначение возвращали задачу целиком (4–9 тыс. знаков, ~14 раз на чат), и
 * каждый следующий вызов перечитывал её; комментарий возвращал свой же текст.
 */
const HOOK = resolve(__dirname, '../../../../../../tools/tracker-brief-hook.mjs');

const ISSUE = {
  id: '10001',
  key: 'PROJ-14',
  summary: 'Кнопка копирования не работает по http',
  browse_url: 'https://tracker.example.com/browse/PROJ-14',
  description: 'Длинное описание задачи. '.repeat(200),
  status: { name: 'В работе', category: 'В работе' },
  assignee: { display_name: 'Исполнитель Тестов', email: 'dev@example.com' },
  comments: [{ id: '1', body: 'старый комментарий '.repeat(50) }],
};

/** Ответ MCP-сервера трекера: текст `{"result": "<JSON>"}`, как на 16.10. */
const wrapped = (payload: object) => JSON.stringify({ result: JSON.stringify(payload, null, 2) });

function hook(input: object) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', ...input }),
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const replaced = (out: string): string =>
  (JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; updatedToolOutput: string } })
    .hookSpecificOutput.updatedToolOutput;

describe('tracker-brief-hook: свёртка ответов трекера', () => {
  it('смена статуса — ключ, сообщение, новый статус, исполнитель и команда полного чтения', () => {
    const run = hook({
      tool_name: 'mcp__tracker__jira_transition_issue',
      tool_input: { issue_key: 'PROJ-14', transition_id: '31' },
      tool_response: wrapped({ message: 'Issue PROJ-14 transitioned successfully', issue: ISSUE }),
    });
    expect(run.code, run.err).toBe(0);
    expect(JSON.parse(run.out).hookSpecificOutput.hookEventName).toBe('PostToolUse');
    const text = replaced(run.out);
    expect(text).toContain('Issue PROJ-14 transitioned successfully');
    expect(text).toContain('status: В работе');
    expect(text).toContain('assignee: Исполнитель Тестов');
    expect(text).toContain('jira_get_issue PROJ-14');
    expect(text).not.toContain('Длинное описание');
    expect(text.length).toBeLessThan(300);
  });

  it('назначение в виде частей MCP (content-массив) — та же свёртка', () => {
    const run = hook({
      tool_name: 'mcp__atlassian-x__jira_assign_issue',
      tool_input: { issue_key: 'PROJ-14', assignee: 'Исполнитель Тестов' },
      tool_response: [
        {
          type: 'text',
          text: wrapped({ message: 'Issue PROJ-14 assigned successfully', issue: ISSUE }),
        },
      ],
    });
    const text = replaced(run.out);
    expect(text).toContain('Issue PROJ-14 assigned successfully');
    expect(text).toContain('assignee: Исполнитель Тестов');
  });

  /** Ревью A2-F17: назначают и правкой полей — ответ тот же, задача целиком. */
  it('правка полей — та же свёртка, описание задачи не возвращается', () => {
    const run = hook({
      tool_name: 'mcp__tracker__jira_update_issue',
      tool_input: { issue_key: 'PROJ-14', fields: { assignee: 'Исполнитель Тестов' } },
      tool_response: wrapped({ message: 'Issue updated successfully', issue: ISSUE }),
    });
    const text = replaced(run.out);
    expect(text).toContain('Issue updated successfully');
    expect(text).toContain('jira_get_issue PROJ-14');
    expect(text).not.toContain('Длинное описание');
  });

  it('комментарий — id, задача и длина вместо эха своего же текста', () => {
    const body = 'Исправление: MR 17. '.repeat(80);
    const run = hook({
      tool_name: 'mcp__tracker__jira_add_comment',
      tool_input: { issue_key: 'PROJ-14', body },
      tool_response: wrapped({ id: '15427', body, created: '2026-10-16T10:00:00Z' }),
    });
    const text = replaced(run.out);
    expect(text).toContain('Comment 15427');
    expect(text).toContain('PROJ-14');
    expect(text).toContain(`${body.length} chars`);
    expect(text).not.toContain('Исправление');
  });

  it('чтение задачи, чужой инструмент, нечитаемый ответ и ответ без задачи — без вмешательства', () => {
    // Каждый ответ свернулся бы, не узнай хук инструмент или форму: у задачи есть
    // id, у чужого ответа — id и текст, у ответа без ключа — сообщение.
    const pass = [
      { tool_name: 'mcp__tracker__jira_get_issue', tool_response: wrapped(ISSUE) },
      { tool_name: 'Bash', tool_response: wrapped({ id: '7', body: 'вывод команды' }) },
      {
        tool_name: 'mcp__tracker__jira_transition_issue',
        tool_response: 'Error: transition 31 is not valid',
      },
      {
        tool_name: 'mcp__tracker__jira_transition_issue',
        tool_response: wrapped({ message: 'no issue here' }),
      },
      {
        tool_name: 'mcp__tracker__jira_transition_issue',
        tool_response: wrapped({ message: 'moved', issue: { status: { name: 'Done' } } }),
      },
      { tool_name: 'mcp__tracker__jira_add_comment', tool_response: wrapped({ body: 'без id' }) },
    ];
    for (const input of pass) {
      const run = hook({ tool_input: { issue_key: 'PROJ-14' }, ...input });
      expect(run.code, input.tool_name).toBe(0);
      expect(run.out, input.tool_name).toBe('');
    }
  });

  it('битый вход на stdin — тишина и код 0: хук не ломает инструмент', () => {
    const result = spawnSync(process.execPath, [HOOK], { input: '{not json', encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
