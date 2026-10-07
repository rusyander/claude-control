import { describe, it, expect } from 'vitest';
import { PANEL_AGENT_BRIDGE_ID } from '@agentdeck/contracts/panel-agent';
import { createCodexTranslator } from './foreign-cli.ts';

/**
 * Перевод JSONL `codex exec --json` в события Claude. Строки сняты с настоящего
 * codex 0.160.0 (`tools/qa/check-panel-agent-codex.mjs`): отказ переходника
 * (`isError: true` в ответе MCP) приходит статусом `failed`, `error: null` и
 * текстом причины в `result.content`.
 */
type CodexLine = Parameters<ReturnType<typeof createCodexTranslator>>[0];
type CodexItem = NonNullable<CodexLine['item']>;

const completed = (
  status: string,
  result: CodexItem['result'],
  error: CodexItem['error'] = null,
) => ({
  type: 'item.completed',
  item: {
    id: 'item_3',
    type: 'mcp_tool_call',
    server: PANEL_AGENT_BRIDGE_ID,
    tool: 'update_settings',
    arguments: { theme: 'neon' },
    result,
    error,
    status,
  },
});

describe('createCodexTranslator — итог вызова переходника', () => {
  it('отказ переходника (failed, error null) — ошибка С ПРИЧИНОЙ из result.content', () => {
    // Без причины итог действия в памяти разговора был «update_settings (failed): » —
    // следующий ход не знал, почему действие не прошло (у Claude и Qwen знал).
    const reason = 'Input rejected by the action schema: theme: Invalid option';
    const [event] = createCodexTranslator()(
      completed('failed', { content: [{ type: 'text', text: reason }] }),
    );
    expect(event?.message?.content?.[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'item_3',
      is_error: true,
      content: [{ type: 'text', text: reason }],
    });
  });

  it('сбой самого Codex (error.message) — причина из error', () => {
    const [event] = createCodexTranslator()(
      completed('failed', null, { message: 'tool call timed out' }),
    );
    expect(event?.message?.content?.[0]).toMatchObject({
      is_error: true,
      content: 'tool call timed out',
    });
  });

  it('успех — содержимое ответа, без пометки ошибки', () => {
    const [event] = createCodexTranslator()(
      completed('completed', {
        content: [{ type: 'text', text: 'Done.' }],
      }),
    );
    expect(event?.message?.content?.[0]).toMatchObject({
      is_error: false,
      content: [{ type: 'text', text: 'Done.' }],
    });
  });
});
