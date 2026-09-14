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
