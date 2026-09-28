import type {
  PanelPluralForm,
  PanelTextCode,
  PanelTextCountCode,
} from '@agentdeck/contracts/panel-agent';

/**
 * Форма словаря без импорта из `texts.ru.ts`: тот вливает этот модуль, и
 * обратный импорт типа замыкал бы круг (`pnpm depcruise`, no-circular). Полноту
 * держит тип `PanelTextDictionary` у места вливания.
 */
type ProjectTexts = { [C in PanelTextCode]?: string } & {
  [K in `${PanelTextCountCode}_${PanelPluralForm}`]?: string;
};

/**
 * Тексты действий агента над проектом (файл инструкций, MCP и права проекта,
 * выбор группы, git, рабочие копии, dev-сервер, чтение кода). Вливаются в
 * `panelTextsRu` одним разворотом: общий словарь правят параллельно. Русский
 * совпадает с запасным текстом сервера (`texts-projects.ts`).
 */
export const panelTextsProjectsRu = {
  'journal-project-claude-md-read': 'Файл инструкций проекта',
  'journal-project-mcp-list': 'MCP-серверы проекта',
  'journal-project-permissions-list': 'Права проекта',
  'journal-project-group-choice': 'Какая группа действует в проекте',
  'journal-project-copy-settings': 'Настройки копий и разделения проекта',
  'journal-project-runner': 'Dev-серверы проекта',
  'journal-project-files': 'Файлы проекта',
  'journal-project-file-read': 'Чтение файла проекта',
  'journal-project-claude-md-save': 'Правка файла инструкций проекта',
  'summary-project-claude-md-save': 'Заменить файл инструкций проекта «{{project}}» целиком',
  'journal-project-mcp-save': 'Правка MCP-сервера проекта',
  'summary-project-mcp-add': 'Добавить MCP-сервер «{{name}}» в проект «{{project}}»',
  'summary-project-mcp-edit': 'Изменить MCP-сервер «{{name}}» проекта «{{project}}»',
  'journal-project-mcp-delete': 'Удаление MCP-сервера проекта',
  'summary-project-mcp-delete': 'Удалить MCP-сервер «{{name}}» из проекта «{{project}}»',
  'journal-project-mcp-toggle': 'Включение или выключение MCP-сервера проекта',
  'summary-project-mcp-enable': 'Включить MCP-сервер «{{name}}» в проекте «{{project}}»',
  'summary-project-mcp-disable': 'Выключить MCP-сервер «{{name}}» в проекте «{{project}}»',
  'journal-project-permission-add': 'Добавление права проекта',
  'summary-project-permission-add': 'Добавить право {{pattern}} в проект «{{project}}»',
  'journal-project-permission-edit': 'Правка права проекта',
  'summary-project-permission-edit': 'Изменить право {{pattern}} проекта «{{project}}»',
  'journal-project-permission-remove': 'Удаление права проекта',
  'summary-project-permission-remove': 'Убрать право {{rule}} из проекта «{{project}}»',
  'label-project-decision': 'Решение',
  'value-project-decision-allow': 'разрешить без вопроса',
  'value-project-decision-ask': 'спрашивать',
  'value-project-decision-deny': 'запретить',
  'journal-project-group-choice-set': 'Смена группы в проекте',
  'summary-project-group-choice': 'Сделать действующей в проекте «{{project}}» группу «{{group}}»',
  'summary-project-group-choice-reset':
    'Вернуть все пары групп проекта «{{project}}» к проектным группам',
  'journal-project-git-checkout': 'Переключение ветки git',
  'summary-project-git-checkout': 'Переключить «{{project}}» на ветку {{branch}}',
  'journal-project-git-branch': 'Новая ветка git',
  'summary-project-git-branch': 'Создать ветку {{branch}} в «{{project}}» и перейти на неё',
  'journal-project-git-commit': 'Коммит git',
  'summary-project-git-commit_one':
    'Закоммитить все изменения ({{count}} файл) в ветку {{branch}} проекта «{{project}}»',
  'summary-project-git-commit_few':
    'Закоммитить все изменения ({{count}} файла) в ветку {{branch}} проекта «{{project}}»',
  'summary-project-git-commit_many':
    'Закоммитить все изменения ({{count}} файлов) в ветку {{branch}} проекта «{{project}}»',
  'summary-project-git-commit_other':
    'Закоммитить все изменения ({{count}} файла) в ветку {{branch}} проекта «{{project}}»',
  'journal-project-git-pull': 'Подтягивание коммитов git',
  'summary-project-git-pull': 'Подтянуть коммиты с удалённого репозитория в «{{project}}»',
  'label-project-git-branch': 'Ветка',
  'label-project-git-message': 'Сообщение коммита',
  'label-project-git-files': 'Файлы',
  'label-project-git-source': 'Откуда',
  'value-project-git-push-human':
    'Коммит остаётся на этой машине: отправить его на сервер можете только вы кнопкой «Отправить»',
  'journal-project-worktree-add': 'Новая рабочая копия',
  'summary-project-worktree-add':
    'Завести рабочую копию под ветку {{branch}} проекта «{{project}}»',
  'journal-project-worktree-remove': 'Удаление рабочей копии',
  'summary-project-worktree-remove': 'Удалить рабочую копию {{path}}',
  'journal-project-worktree-bootstrap': 'Установка зависимостей в копии',
  'summary-project-worktree-bootstrap': 'Запустить установку зависимостей в копии {{path}}',
  'journal-project-worktree-mirror': 'Перенос локального слоя в копию',
  'summary-project-worktree-mirror':
    'Перенести в копию {{path}} локальный слой проекта (только то, что в копии старее)',
  'label-project-worktree-path': 'Каталог копии',
  'label-project-worktree-install': 'Команда после создания',
  'value-project-worktree-install-none': 'нет: ни своей команды, ни lock-файла',
  'value-project-worktree-force': 'незакоммиченные правки копии пропадут',
  'journal-project-mirror-settings': 'Настройки копий проекта',
  'summary-project-mirror-settings': 'Изменить настройки копий проекта «{{project}}»',
  'journal-project-split-settings': 'Настройки разделения проекта',
  'summary-project-split-settings': 'Изменить настройки разделения проекта «{{project}}»',
  'journal-project-runner-settings': 'Настройки dev-сервера',
  'summary-project-runner-settings': 'Изменить настройки dev-сервера «{{target}}»',
  'journal-project-runner-autostart': 'Автозапуск dev-сервера',
  'summary-project-runner-autostart-on': 'Включить автозапуск dev-сервера «{{target}}»',
  'summary-project-runner-autostart-off': 'Выключить автозапуск dev-сервера «{{target}}»',
  'value-project-runner-autostart':
    'команда выполнится сама при каждом следующем старте панели, без карточки',
  'journal-project-runner-start': 'Запуск dev-сервера',
  'summary-project-runner-start': 'Запустить dev-сервер «{{target}}»',
  'journal-project-runner-stop': 'Остановка dev-сервера',
  'summary-project-runner-stop': 'Остановить dev-сервер «{{target}}»',
  'journal-project-free-port': 'Освобождение порта',
  'summary-project-free-port': 'Освободить порт {{port}}: погасить процессы, которые его слушают',
  'label-project-runner-port': 'Порт',
  'label-project-runner-script': 'Скрипт package.json, который исполнится',
  'label-project-port-holders': 'Кто слушает порт',
} satisfies ProjectTexts;
