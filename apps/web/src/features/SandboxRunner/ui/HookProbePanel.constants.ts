/** Заготовка ввода: подсказывает форму события Claude Code hook. */
export const CUSTOM_EVENT_TEMPLATE = JSON.stringify(
  {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /tmp/demo' },
  },
  null,
  2,
);
