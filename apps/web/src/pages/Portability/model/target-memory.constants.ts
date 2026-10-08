/**
 * Ключ памяти браузера: цель переноса помнит этот зритель, а не сервер. Имя —
 * по общему образцу `agentdeck:<что>`, как у остальных ключей панели.
 */
export const TRANSFER_TARGET_KEY = 'agentdeck:portability-target';

/**
 * Прежнее имя ключа (с точками — единственный такой в панели). Читается один
 * раз и переносится под новое: выбор, сделанный до переименования, не теряется.
 */
export const LEGACY_TRANSFER_TARGET_KEY = 'agentdeck.portability.target';
