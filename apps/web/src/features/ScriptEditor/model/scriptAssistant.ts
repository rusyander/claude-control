import type { AssistantSpec } from '@shared/lib/assistant-fields';

/**
 * Поля скрипта. Подсказка о хуках — только там, где хуки есть (у Claude):
 * иначе помощник писал бы протокол, которого у провайдера нет.
 */
export function scriptAssistantSpec({ hasHooks }: { hasHooks: boolean }) {
  return {
    name: { type: 'text', hint: 'Script file name with extension, e.g. notify.mjs' },
    content: {
      type: 'text',
      hint: hasHooks
        ? 'The full script code. Claude Code hooks get JSON on stdin and may return JSON on stdout; ' +
          'exit code 2 blocks the action. Write Node.js (.mjs), comments in the language the user writes in'
        : 'The full code of a standalone script: arguments from process.argv, output to stdout, ' +
          'a non-zero exit code on error. Write Node.js (.mjs), comments in the language the user writes in',
    },
  } satisfies AssistantSpec;
}
