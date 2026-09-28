import type { AssistantSpec } from '@shared/lib/assistant-fields';

/**
 * Поля правила для помощника. Конструктор из блоков собирает тот же markdown,
 * что лежит в `body`, поэтому отдельного поля у него нет: текст помощника
 * открывается в простом режиме.
 */
export function ruleAssistantSpec() {
  return {
    title: { type: 'text', hint: 'Short rule title' },
    body: {
      type: 'text',
      hint: 'Rule text in markdown: what to do, what not to do, how to check it',
    },
  } satisfies AssistantSpec;
}
