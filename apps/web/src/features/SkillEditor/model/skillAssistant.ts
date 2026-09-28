import type { AssistantSpec } from '@shared/lib/assistant-fields';

interface SkillAssistantInput {
  /** Скилл уже на диске: имя = папка, правится только переименованием. */
  created: boolean;
  /** Правится существующий скилл — доступно переименование папки. */
  editing: boolean;
  /** Заготовки структуры (до создания скилла). */
  templates: ReadonlyArray<{ id: string; title: string }>;
}

/** Каждое поле окна скилла: тексты, заготовка структуры, новое имя папки. */
export function skillAssistantSpec({ created, editing, templates }: SkillAssistantInput) {
  return {
    name: { type: 'text', hint: 'Skill name in Latin letters, kebab-case', off: created },
    description: {
      type: 'text',
      hint:
        'When to use the skill: the situation and the user wording. Claude decides by this ' +
        'field whether to load the skill',
    },
    body: {
      type: 'text',
      hint: 'Instructions in markdown: what to do step by step, what not to do, how to check the result',
    },
    structureTemplate: {
      type: 'choice',
      hint:
        'File structure template for a skill with extra files; picking one switches the form ' +
        'to the builder, and the files appear right after the skill is created',
      off: created,
      options: templates.map((template) => ({ value: template.id, label: template.title })),
    },
    renameTo: {
      type: 'text',
      hint: 'New folder name (the skill id) for renaming; the user confirms it with the Rename button',
      off: !editing,
    },
  } satisfies AssistantSpec;
}
