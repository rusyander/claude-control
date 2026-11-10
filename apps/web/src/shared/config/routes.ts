/**
 * Адреса страниц, на которые ссылается не только сам раздел.
 *
 * Типом здесь стоит `string`, а не литерал: маршруты собираются циклом, и
 * типизированного дерева путей у роутера нет — литерал не прошёл бы проверку.
 */
export const HELP_ROUTE: string = '/help';
export const SETTINGS_ROUTE: string = '/settings';
/** Прогон агента ссылается на свой разговор: `/chat?id=<сессия>`. */
export const CHAT_ROUTE: string = '/chat';
/** Маска контура ссылается на правила, которыми маскирует. */
export const DLP_ROUTE: string = '/dlp';
/** Локальные модели — на них ссылается подсказка под чатом. */
export const LOCAL_MODELS_ROUTE: string = '/local-models';
/**
 * Задачи ядра: список, одна задача — `/core?id=<taskId>`. На него ссылаются лента задачи
 * («назад») и карточка запуска (`/core/launch`) после старта.
 */
export const CORE_TASKS_ROUTE: string = '/core';
/**
 * Полосы групп доски ядра — бывший раздел «Группы» (этап 12, D13): меню, обзор и агент панели
 * ведут сюда напрямую, прежний `/groups` остался только переадресацией для старых ссылок.
 */
export const CORE_GROUP_LANES_SEARCH = { view: 'board', lane: 'group' } as const;
