import type { ResourceKind } from './registry.ts';

/**
 * Заготовки структуры.
 *
 * Начинать скилл с пустого файла тяжело: непонятно, что куда класть и как
 * связать части. Шаблон даёт рабочую форму — тонкий вход и модули по темам, —
 * которую остаётся наполнить.
 *
 * Шаблон это данные, а не код: чтобы добавить новую заготовку или завести
 * шаблоны для другого вида ресурса, достаточно дописать запись сюда.
 */

export interface ResourceTemplate {
  id: string;
  kind: ResourceKind;
  title: string;
  description: string;
  /** Файлы шаблона: путь и содержимое. */
  files: { path: string; content: string }[];
}

/**
 * Внутри SKILL.md обязательно ссылаемся на вложенные файлы: Claude Code не
 * подхватывает их сам — он читает только то, на что есть ссылка.
 */
const SKILL_HEADER = (name: string, description: string) =>
  `---
name: ${name}
description: ${description}
---

# ${name}

Коротко: что делает этот скилл и когда применяется.

## Когда применять

- случай, в котором скилл нужен
- ещё один случай

## Как действовать

1. Первый шаг.
2. Второй шаг.
`;

export const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    id: 'skill-minimal',
    kind: 'skill',
    title: 'Простой скилл',
    description: 'Один файл SKILL.md. Подходит, когда правило умещается на страницу.',
    files: [
      {
        path: 'SKILL.md',
        content: SKILL_HEADER(
          'new-skill',
          'Use КОГДА — опишите здесь случай, в котором Claude должен применить этот скилл',
        ),
      },
    ],
  },
  {
    id: 'skill-references',
    kind: 'skill',
    title: 'Скилл с модулями',
    description:
      'Тонкий SKILL.md и папка references/ по темам. Форма, в которой сделаны крупные скиллы: сам вход короткий, подробности грузятся по надобности.',
    files: [
      {
        path: 'SKILL.md',
        content: `${SKILL_HEADER(
          'new-skill',
          'Use КОГДА — опишите здесь случай, в котором Claude должен применить этот скилл',
        )}
## Подробности по темам

Читайте нужный модуль — целиком всё загружать не требуется:

- [Основные правила](references/rules.md)
- [Примеры](references/examples.md)

> Ссылки обязательны: вложенные файлы Claude Code сам не читает,
> он открывает только то, на что сослались отсюда.
`,
      },
      {
        path: 'references/rules.md',
        content: `# Основные правила

Подробные требования, которые не поместились во вход.
`,
      },
      {
        path: 'references/examples.md',
        content: `# Примеры

## Хороший пример

Что и почему сделано правильно.

## Плохой пример

Как делать не надо и чем это плохо.
`,
      },
    ],
  },
  {
    id: 'skill-full',
    kind: 'skill',
    title: 'Скилл с конфигами и шаблонами',
    description:
      'Модули по темам плюс config/ и templates/ — для скиллов, которые подставляют готовые файлы в проект.',
    files: [
      {
        path: 'SKILL.md',
        content: `${SKILL_HEADER(
          'new-skill',
          'Use КОГДА — опишите здесь случай, в котором Claude должен применить этот скилл',
        )}
## Модули

- [Правила](references/rules.md)
- [Готовые конфиги](config/README.md)
- [Шаблоны](templates/README.md)

Пути внутри скилла доступны как \`\${CLAUDE_SKILL_DIR}/…\` — так на файлы
можно сослаться из команд.
`,
      },
      {
        path: 'references/rules.md',
        content: '# Правила\n\nПодробные требования.\n',
      },
      {
        path: 'config/README.md',
        content: '# Конфиги\n\nГотовые файлы настроек, которые скилл подставляет в проект.\n',
      },
      {
        path: 'templates/README.md',
        content: '# Шаблоны\n\nЗаготовки файлов, создаваемых по этому скиллу.\n',
      },
    ],
  },
  {
    id: 'script-hook-guard',
    kind: 'script',
    title: 'Скрипт-страж',
    description:
      'Заготовка хука, который проверяет действие и при необходимости требует подтверждения.',
    files: [
      {
        path: 'new-guard.mjs',
        content: `#!/usr/bin/env node
/**
 * Страж: проверяет действие перед выполнением и при необходимости просит
 * подтверждения у пользователя.
 */
import { stdin } from 'node:process';

let raw = '';
for await (const chunk of stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const command = String(input?.tool_input?.command ?? '');

// Условие срабатывания — замените на своё.
const isDangerous = /rm\\s+-rf/.test(command);

if (isDangerous) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'Страж: команда выглядит разрушительной.',
      },
    }),
  );
}

process.exit(0);
`,
      },
    ],
  },
];

export function templatesFor(kind: string): ResourceTemplate[] {
  return RESOURCE_TEMPLATES.filter((template) => template.kind === kind);
}

export function templateById(id: string): ResourceTemplate | undefined {
  return RESOURCE_TEMPLATES.find((template) => template.id === id);
}
