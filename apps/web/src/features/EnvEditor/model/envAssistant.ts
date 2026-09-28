import type { AssistantSpec } from '@shared/lib/assistant-fields';

/**
 * Поля переменной для помощника. Файл при правке определяется записью и не
 * меняется — тогда поле закрыто, и присланное помощником называется, а не
 * применяется молча.
 */
export function envAssistantSpec({ sourceLocked }: { sourceLocked: boolean }) {
  return {
    key: { type: 'text', hint: 'Variable name in UPPER_SNAKE_CASE' },
    value: { type: 'text', hint: 'Variable value' },
    source: {
      type: 'choice',
      hint: 'Where to save the variable',
      off: sourceLocked,
      options: [
        { value: 'secrets', label: '.mcp-secrets.env — the token file MCP launchers read' },
        { value: 'settings', label: 'settings.json — Claude Code itself sees it' },
      ],
    },
    comment: { type: 'text', hint: 'Comment: where the value comes from or what it is for' },
  } satisfies AssistantSpec;
}
