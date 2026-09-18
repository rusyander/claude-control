import type { ChecksMessageCode } from '@agentdeck/contracts/server-messages';

export const checksRu: Record<ChecksMessageCode, string> = {
  'checks-section-mcp': 'MCP-серверы',
  'checks-section-permissions': 'Права',
  'checks-section-env': 'Переменные окружения',
  'checks-skip-own-routes':
    '{{title}}: раздел обслуживается собственными маршрутами панели, универсальный круг записи к нему не применяется.',
  'checks-skip-absent': '{{title}}: у этого провайдера такого раздела нет.',
  'checks-assistant-off': 'Запуск ассистента отключён в этой проверке.',
  'checks-assistant-unsupported': 'Ассистент у этого провайдера не поддержан.',
  'checks-assistant-launch-failed': 'Запуск не состоялся: {{reason}}',
  'checks-assistant-nothing-to-run':
    'Запускать нечем: CLI не найден и ключ не задан — это не отказ провайдера.',
  'checks-assistant-error': 'Ассистент ответил ошибкой.',
  'checks-assistant-empty': 'Ассистент ответил пустым сообщением.',
  'checks-assistant-ok': 'Ассистент ответил через {{mode}}: «{{reply}}».',
  'checks-cli-found': 'Команда {{command}} найдена в PATH.',
  'checks-cli-missing':
    'Бинарь CLI в PATH не найден. Разделы конфигурации от этого не ломаются — ограничен только запуск ассистента через CLI.',
  'checks-config-undeclared': 'Расположение конфигурации у провайдера не объявлено.',
  'checks-config-missing':
    'Ни один из путей конфигурации не найден ({{paths}}). Обычно они появляются после первого запуска CLI.',
  'checks-config-present': 'Конфигурация на месте: {{paths}}.',
  'checks-format-rejected': 'Формат файла не принят: {{reason}}',
  'checks-mcp-reread-missing':
    'Запись пробного сервера прошла, но при перечитывании его нет — формат файла разобран не полностью.',
  'checks-mcp-neighbours':
    'После добавления и удаления пробного сервера список отличается от исходного — запись меняет соседние записи.',
  'checks-mcp-ok': 'Круг чтения-записи сошёлся на копии файла, серверов в нём: {{count}}.',
  'checks-permissions-meaning':
    'Перезапись прочитанных прав изменила их смысл — формат разобран не полностью.',
  'checks-permissions-ok':
    'Права прочитаны и записаны обратно на копии файла без изменения смысла.',
  'checks-env-reread-missing':
    'Пробная переменная записана, но при перечитывании её нет — формат разобран не полностью.',
  'checks-env-set-differs':
    'После добавления и удаления пробной переменной набор отличается от исходного.',
  'checks-env-ok': 'Круг чтения-записи сошёлся на копии файла, переменных в нём: {{count}}.',
  'checks-instructions-unsupported': 'Раздел инструкций у этого провайдера не поддержан.',
  'checks-instructions-cursor':
    'Инструкции Cursor — каталог правил `.mdc`; круг записи по каталогу не выполняется.',
  'checks-instructions-list-not-allowed': 'Список инструкций не разрешён.',
  'checks-instructions-list-changed': 'Перезапись списка ссылок изменила его состав.',
  'checks-instructions-list-ok':
    'Список ссылок перезаписан без изменений, записей в нём: {{count}}.',
  'checks-instructions-undeclared': 'Файл инструкций у провайдера не объявлен.',
  'checks-instructions-file-absent':
    'Файла {{path}} ещё нет — он появится, когда инструкции будут заданы.',
  'checks-instructions-file-ok':
    'Файл инструкций читается и записывается без изменений ({{count}} символов).',
  'checks-instructions-file-changed': 'Перезапись файла инструкций изменила его текст.',
  'checks-instructions-file-unread': 'Файл не прочитан: {{reason}}',
  'sandbox-event-bash-safe-title': 'Безобидная команда',
  'sandbox-event-bash-safe-description': 'Обычный вызов Bash — страж не должен вмешиваться.',
  'sandbox-event-bash-destructive-title': 'Рекурсивное удаление',
  'sandbox-event-bash-destructive-description':
    'Опасная команда — страж разрушительных операций должен остановить.',
  'sandbox-event-git-push-title': 'Мутирующая операция git',
  'sandbox-event-git-push-description':
    'Пуш в удалённый репозиторий — по правилам агент этого делать не должен.',
  'sandbox-event-write-secret-title': 'Запись секрета в файл',
  'sandbox-event-write-secret-description':
    'В содержимом похожий на токен ключ — страж секретов должен вмешаться.',
  'sandbox-event-write-placeholder-title': 'Ключ-заготовка в примере',
  'sandbox-event-write-placeholder-description':
    'Значение-плейсхолдер в .env.example — страж не должен мешать.',
  'sandbox-event-write-plain-title': 'Обычная правка файла',
  'sandbox-event-write-plain-description':
    'Правка исходника — сюда обычно вешают автоформатирование.',
  'sandbox-event-prompt-figma-title': 'Запрос со ссылкой на Figma',
  'sandbox-event-prompt-figma-description': 'Подсказки на ввод пользователя срабатывают здесь.',
  'sandbox-event-session-start-title': 'Начало сессии',
  'sandbox-event-session-start-description': 'Брифинги и напоминания при старте.',
  'sandbox-event-stop-title': 'Конец ответа',
  'sandbox-event-stop-description': 'Проверки, которые запускаются после ответа модели.',
  'sandbox-event-bad-json': 'Не удалось разобрать JSON: проверьте синтаксис события.',
  'sandbox-event-not-object': 'Событие должно быть JSON-объектом вида {"hook_event_name": "…"}.',
};
