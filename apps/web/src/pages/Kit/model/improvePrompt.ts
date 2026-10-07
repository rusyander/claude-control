import type { KitItemKind } from '@agentdeck/contracts/kit';

/**
 * Задание агенту по кнопке «Улучшить». Его читает модель, поэтому оно всегда
 * английское и сжатое, при любом языке интерфейса: экономия лимитов и трафика.
 * Человеку показываются только подписи кнопок и уведомления — те идут из словаря.
 */
export function improvePrompt(input: {
  name: string;
  kind: KitItemKind;
  builtin: string;
  mine: string;
}): string {
  return [
    `Improve panel kit item "${input.name}" (${input.kind}).`,
    '',
    `Built-in text (read only, ships with the panel): ${input.builtin}`,
    `Write your edit as the "mine" copy: ${input.mine} (create missing folders).`,
    '',
    'Keep the file format (name/description front matter of skills, commands, agents).',
    'Model-facing text stays English and compressed. Make it shorter and more precise,',
    'drop repetition, add missing verification steps. Finish with a list of what changed and why,',
    "in the user's language.",
  ].join('\n');
}
