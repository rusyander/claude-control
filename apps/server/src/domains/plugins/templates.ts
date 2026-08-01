/**
 * Заготовки файлов нового плагина. Форматы — по докам Claude Code: фронтматтер
 * команды, субагента и скилла, `hooks.json` и README.
 */

/** Пример команды: фронтматтер по формату Claude Code + тело-подсказка. */
export function commandTemplate(slug: string): string {
  return `---
description: Пример команды плагина ${slug}
argument-hint: [аргумент]
allowed-tools: Read
---

Опишите здесь, что должна сделать команда. Доступны:
- аргументы: $1, $2 или $ARGUMENTS
- файлы: @путь/к/файлу
- вывод команды: !\`команда\`
`;
}

/** Пример субагента: минимальный фронтматтер name + description. */
export function agentTemplate(slug: string): string {
  return `---
name: ${slug}-helper
description: Пример субагента плагина ${slug}. Опишите, когда его вызывать.
---

Системная инструкция субагента. Опишите его роль, границы и формат ответа.
`;
}

/** Пример скилла: фронтматтер SKILL.md с name и description. */
export function skillTemplate(slug: string): string {
  return `---
name: ${slug}
description: Пример скилла плагина ${slug}. Опишите, при каких запросах он применяется.
---

# ${slug}

Тело скилла: шаги, правила и примеры. Файлы рядом (references/, scripts/)
подхватываются автоматически.
`;
}

/** Пример hooks.json: один PreToolUse-хук с командой через CLAUDE_PLUGIN_ROOT. */
export function hooksTemplate(): string {
  return `${JSON.stringify(
    {
      description: 'Пример хуков плагина',
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [
              {
                type: 'command',
                command: '${CLAUDE_PLUGIN_ROOT}/hooks/scripts/example.sh',
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

export function readmeTemplate(slug: string, description: string): string {
  return `# ${slug}

${description || 'Плагин Claude Code.'}

## Структура

- \`.claude-plugin/plugin.json\` — манифест плагина
- \`commands/\` — слэш-команды (Markdown с фронтматтером)
- \`agents/\` — субагенты
- \`skills/\` — скиллы (папка с \`SKILL.md\`)
- \`hooks/hooks.json\` — хуки на события

## Установка для разработки

Добавьте маркетплейс из папки-родителя и установите плагин через
\`claude plugin\`.
`;
}
