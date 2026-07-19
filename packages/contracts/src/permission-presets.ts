/**
 * Заготовки правил доступа — то, что Claude Code делает с вашей системой.
 * Список нужен, чтобы не сочинять синтаксис: правила пишутся в особом формате
 * `Инструмент(аргумент:шаблон)`, и ошибиться в нём легко.
 */
export interface PermissionPreset {
  id: string;
  /** Шаблон правила, готовый к вставке. */
  pattern: string;
  title: string;
  description: string;
  /** Насколько действие опасно: влияет на рекомендуемое решение. */
  risk: 'low' | 'medium' | 'high';
  category: 'filesystem' | 'shell' | 'network' | 'git' | 'tools';
}

export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  // Файловая система
  {
    id: 'read-any',
    pattern: 'Read',
    title: 'Чтение любых файлов',
    description: 'Claude может открывать файлы проекта без спроса.',
    risk: 'low',
    category: 'filesystem',
  },
  {
    id: 'edit-any',
    pattern: 'Edit',
    title: 'Правка файлов',
    description: 'Изменение существующих файлов.',
    risk: 'medium',
    category: 'filesystem',
  },
  {
    id: 'write-any',
    pattern: 'Write',
    title: 'Создание файлов',
    description: 'Создание новых файлов и перезапись существующих.',
    risk: 'medium',
    category: 'filesystem',
  },
  // Оболочка
  {
    id: 'bash-any',
    pattern: 'Bash',
    title: 'Любые команды оболочки',
    description: 'Полный доступ к терминалу. Самое широкое из разрешений.',
    risk: 'high',
    category: 'shell',
  },
  {
    id: 'bash-npm',
    pattern: 'Bash(npm run:*)',
    title: 'Команды npm run',
    description: 'Только скрипты проекта: сборка, тесты, линт.',
    risk: 'low',
    category: 'shell',
  },
  {
    id: 'bash-rm',
    pattern: 'Bash(rm:*)',
    title: 'Удаление файлов из оболочки',
    description: 'Команда rm. Обычно её ставят в запрет.',
    risk: 'high',
    category: 'shell',
  },
  // Git
  {
    id: 'git-status',
    pattern: 'Bash(git status:*)',
    title: 'Состояние репозитория',
    description: 'Чтение состояния git — безопасно.',
    risk: 'low',
    category: 'git',
  },
  {
    id: 'git-commit',
    pattern: 'Bash(git commit:*)',
    title: 'Коммиты',
    description: 'Создание коммитов в репозитории.',
    risk: 'medium',
    category: 'git',
  },
  {
    id: 'git-push',
    pattern: 'Bash(git push:*)',
    title: 'Отправка в удалённый репозиторий',
    description: 'Изменения уходят на сервер и видны команде.',
    risk: 'high',
    category: 'git',
  },
  // Сеть и внешние источники
  {
    id: 'web-fetch',
    pattern: 'WebFetch',
    title: 'Загрузка страниц',
    description: 'Claude может скачивать содержимое по ссылкам.',
    risk: 'medium',
    category: 'network',
  },
  {
    id: 'web-search',
    pattern: 'WebSearch',
    title: 'Поиск в интернете',
    description: 'Поисковые запросы во внешние сервисы.',
    risk: 'low',
    category: 'network',
  },
  // Инструменты
  {
    id: 'task',
    pattern: 'Task',
    title: 'Запуск подчинённых агентов',
    description: 'Claude может запускать фоновых агентов для больших задач.',
    risk: 'medium',
    category: 'tools',
  },
  {
    id: 'skill',
    pattern: 'Skill',
    title: 'Вызов скиллов',
    description: 'Подключение ваших наборов инструкций.',
    risk: 'low',
    category: 'tools',
  },
];
