import { HOOK_EVENT_INFO, HOOK_TEMPLATES } from '@agentdeck/contracts';
import type { AssistantSpec } from '@shared/lib/assistant-fields';

/** Все инструменты, которые форма предлагает фильтром, — примеры для модели. */
const MATCHER_EXAMPLES = [...new Set(HOOK_EVENT_INFO.flatMap((info) => info.matcherExamples))];

const MATCHER_EVENTS = HOOK_EVENT_INFO.filter((info) => info.supportsMatcher)
  .map((info) => info.event)
  .join(', ');

const TEMPLATE_LABEL: Record<(typeof HOOK_TEMPLATES)[number], string> = {
  message: 'a hint',
  guard: 'a block',
  shell: 'a shell command',
  blank: 'an empty script',
};

/** Каждое поле конструктора хука, включая таймаут и фильтры списком. */
export function hookAssistantSpec() {
  return {
    event: {
      type: 'choice',
      hint: 'Claude Code event the hook fires on',
      options: HOOK_EVENT_INFO.map((info) => ({ value: info.event })),
    },
    matchers: {
      type: 'list',
      hint:
        `Tools the hook is limited to, only for events with a matcher (${MATCHER_EVENTS}); ` +
        'an empty array means every tool',
      suggestions: MATCHER_EXAMPLES,
    },
    scriptName: {
      type: 'text',
      hint: 'Script file name without extension, Latin letters in kebab-case',
    },
    template: {
      type: 'choice',
      hint: 'Action type of the new script',
      options: HOOK_TEMPLATES.map((value) => ({ value, label: TEMPLATE_LABEL[value] })),
    },
    description: { type: 'text', hint: 'One sentence on what the hook does' },
    message: { type: 'text', hint: 'Text of the hint, or the message shown when the block fires' },
    guardPatterns: {
      type: 'text',
      hint: 'For the guard type: what to intercept, comma-separated',
    },
    command: {
      type: 'text',
      hint: 'For the shell type, or for an existing hook: the shell command',
    },
    timeout: {
      type: 'number',
      hint: 'Timeout in seconds',
      integer: true,
      min: 1,
      nullable: true,
    },
  } satisfies AssistantSpec;
}
