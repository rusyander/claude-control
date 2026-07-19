import type { HookEvent } from '@claude-control/contracts';

/**
 * Готовые хуки под типовые задачи. Хук — штука из нескольких увязанных полей
 * (событие, фильтр, тип действия, шаблон скрипта), и собрать рабочий вариант
 * с нуля непросто. Пресет заполняет всё разом — остаётся поправить детали.
 */
export interface HookPreset {
  id: string;
  title: string;
  description: string;
  event: HookEvent;
  matchers: string[];
  template: string;
  scriptName: string;
  message?: string;
  guardPatterns?: string;
  command?: string;
}

export const HOOK_PRESETS: HookPreset[] = [
  {
    id: 'destructive-guard',
    title: 'Страж разрушительных команд',
    description: 'Останавливает опасные команды в Bash до выполнения и требует подтверждения.',
    event: 'PreToolUse',
    matchers: ['Bash', 'PowerShell'],
    template: 'guard',
    scriptName: 'destructive-guard',
    guardPatterns: 'rm -rf, DROP TABLE, TRUNCATE, kubectl delete, docker volume rm',
  },
  {
    id: 'secret-guard',
    title: 'Страж секретов',
    description: 'Проверяет запись файлов на похожие на токены строки.',
    event: 'PreToolUse',
    matchers: ['Write', 'Edit'],
    template: 'guard',
    scriptName: 'secret-guard',
    guardPatterns: 'glpat-, ghp_, sk-, AKIA, -----BEGIN',
  },
  {
    id: 'format-on-save',
    title: 'Формат при сохранении',
    description: 'Запускает форматтер после правки файла.',
    event: 'PostToolUse',
    matchers: ['Write', 'Edit'],
    template: 'shell',
    scriptName: 'format-on-edit',
    command: 'npx prettier --write "$CLAUDE_FILE_PATH"',
  },
  {
    id: 'session-brief',
    title: 'Брифинг при старте',
    description: 'Показывает напоминание или контекст в начале сессии.',
    event: 'SessionStart',
    matchers: [],
    template: 'message',
    scriptName: 'session-brief',
    message: 'Напоминание: сверься с .agent/notes.md перед работой.',
  },
  {
    id: 'precompact-checkpoint',
    title: 'Чек-поинт перед сжатием',
    description: 'Просит выписать состояние перед сжатием контекста.',
    event: 'PreCompact',
    matchers: [],
    template: 'message',
    scriptName: 'precompact-checkpoint',
    message: 'Контекст скоро сожмётся — выпиши прогресс в .agent/PROGRESS.md.',
  },
];
