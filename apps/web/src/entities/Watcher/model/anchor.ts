/**
 * Глубокая ссылка на карточку наблюдателя в настройках: вкладка «Общие» и
 * якорь `#watcher`. Карточка по якорю прокручивается к себе и ставит фокус на
 * тумблер — так «Перейти в настройки» из индикатора приводит ровно к нему.
 */
export const WATCHER_ANCHOR = 'watcher';
export const watcherSettingsTab = 'general';
/** Событие окна: индикатор просит уже открытую карточку снова взять фокус. */
export const WATCHER_FOCUS_EVENT = 'agentdeck:watcher-focus';
