import type { SignalFactKey, SignalId, SignalSubject } from '@agentdeck/contracts/core/signal-view';

/**
 * Шаблоны сигналов ленты (этап 9): заголовок на каждый id каталога ядра (закрытый список
 * контрактов `SIGNAL_VIEW`), подпись предмета и подписи фактов JSON-детали. Тип исчерпывающий:
 * новый сигнал ядра без заголовка — ошибка сборки, а не сырой id у человека. Проза детали
 * показывается дословно — сюда она не переводится (P32).
 */
export interface SignalTexts {
  titles: { [S in SignalId]: string };
  subjects: { [K in SignalSubject]: string };
  facts: { [F in SignalFactKey]: string };
}

export const signalsRu: SignalTexts = {
  titles: {
    preflight: 'Предпроверка запуска',
    'ask-reminder': 'Напоминание о вопросе человеку',
    'estimate-refused': 'Оценка отказала — задача не пойдёт',
    'base-pin': 'База репозитория приколота',
    'user-layer-report': 'Слой пользователя на запуске',
    'estimate-history': 'Оценка по истории прогонов',
    ownership: 'Правка вне своих путей',
    'forged-authority': 'Поддельное полномочие',
    'step-done-refused': 'Завершение шага отклонено',
    'step-done-invalid': 'Завершение шага с ошибкой в полях',
    'step-blocker': 'Препятствие шага',
    'model-served': 'Модель, которая ответила',
    'route-mismatch': 'Ответила не та модель маршрута',
    'profile-moved': 'Профиль проекта изменился',
    'context-drift': 'Контекст первого хода больше ожидаемого',
    'forged-publish': 'Публикация в обход ядра',
    'hook-block': 'Хук отказал вызову',
    'hook-loop': 'Хук отказывает по кругу',
    'keep-warm': 'Сессия прогрета',
    'session-refused': 'Сессия не открылась',
    'read-allow-unread': 'Список разрешённого чтения не прочитан',
    'read-scope-refused': 'Запись области чтения не принята',
    'permit-sources-unread': 'Источник грантов не прочитан',
    'capture-roads': 'Дороги перехвата команд',
    'resources-unread': 'Ресурсы сессии не прочитаны',
    'protected-root-unread': 'Защищённый корень не прочитан',
    'protected-root': 'Изменение в защищённом корне',
    'route-lease': 'Аренда маршрута',
    'layer-loss': 'Потеря в слое пользователя',
    'session-snapshot': 'Снимок сессии записан',
    'journal-rejected': 'Журнал отверг строку',
    'waste-reread': 'Повторное чтение без изменений',
    'waste-big-read': 'Большой файл прочитан целиком',
    'waste-fail-repeat': 'Та же команда упала снова',
    'waste-poll': 'Ожидание в цикле',
    'waste-refusal-repeat': 'Повторный отказ того же действия',
    'context-growth': 'Контекст сессии разросся',
    stall: 'Сессия затихла',
    'resource-leak': 'Утечка ресурса',
    window: 'Окно маршрута сменилось',
  },
  subjects: {
    phase: 'Этап',
    ask: 'Вопрос',
    repo: 'Репозиторий',
    step: 'Шаг',
    session: 'Сессия',
    target: 'Цель',
    kind: 'Вид',
    model: 'Модель',
    hook: 'Хук',
    config: 'Файл настроек',
    entry: 'Запись',
    path: 'Путь',
    lease: 'Аренда',
    snapshot: 'Снимок',
    line: 'Вид строки',
    command: 'Команда',
    resource: 'Ресурс',
    route: 'Маршрут',
  },
  facts: {
    problems: 'Причины',
    minutes: 'Минуты',
    tokens: 'Токены',
    spread: 'Разброс p10–p90',
    basis: 'Основание',
    reasons: 'Причины',
    route: 'Маршрут',
    model: 'Модель',
    resources: 'Ресурсы',
    hash: 'Отпечаток',
    hooks: 'Хуки',
    skills: 'Скиллы',
    warnings: 'Предупреждения',
    sources: 'Источники',
    grants: 'Гранты',
    changes: 'Подмены',
  },
};
