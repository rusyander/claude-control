import { PREFIX } from './draft-storage.constants';

/**
 * Черновики форм в localStorage: набранный, но не отправленный текст переживает
 * перезагрузку страницы. Пустой черновик не храним — убираем ключ, чтобы не
 * копить мусор. Доступ к хранилищу обёрнут в try/catch: в приватном режиме или
 * при переполнении localStorage кидается, а черновик — не та вещь, ради которой
 * стоит ронять форму.
 */

/** Прочитать черновик по ключу контекста (пусто, если его нет). */
export function loadDraft(key: string): string {
  try {
    return localStorage.getItem(PREFIX + key) ?? '';
  } catch {
    return '';
  }
}
