import { sandboxKey } from './SandboxPaths.ts';

/**
 * Песочницы с живым прогоном: пока внутри работает CLI, подметать нельзя.
 *
 * Свежесть по mtime — признак приблизительный: длинный агентный ход может
 * часами ничего не писать на диск, и такая песочница читалась как брошенная.
 * Сервер при этом точно знает, что в ней кто-то работает (реестр `running` в
 * маршрутах), — этим знанием и пользуемся.
 */
const busySandboxes = new Set<string>();

/**
 * Песочницы, которые унесло подметание. Нужны маршруту прогона: папки нет, но
 * это не «песочницы никогда не было», а «время вышло». Разница видима
 * пользователю — без неё на месте стёртой молча собиралась ПУСТАЯ песочница, и
 * прогон отвечал так, будто проверяемое правило ни на что не влияет.
 */
const expiredSandboxes = new Set<string>();

/** Потолок памяти реестра: за сутки работы панели имён накапливается много. */
const EXPIRED_LIMIT = 200;

export function markSandboxBusy(id: string): void {
  busySandboxes.add(sandboxKey(id));
}

export function markSandboxFree(id: string): void {
  busySandboxes.delete(sandboxKey(id));
}

/** Песочницу унесло подметание — папки нет по истечении простоя, а не по ошибке. */
export function isSandboxExpired(id: string): boolean {
  return expiredSandboxes.has(sandboxKey(id));
}

/** Идёт ли в песочнице прогон. Ключ — имя папки на диске, а не исходный id. */
export function isSandboxBusy(key: string): boolean {
  return busySandboxes.has(key);
}

/** Собранная заново песочница живая, чем бы ни была прежняя с тем же именем. */
export function forgetExpired(id: string): void {
  expiredSandboxes.delete(sandboxKey(id));
}

/**
 * Удалили по просьбе — это не «время вышло»: следующий прогон с тем же id
 * должен собрать песочницу заново, а не получить отказ по истечению.
 */
export function forgetSandbox(key: string): void {
  busySandboxes.delete(key);
  expiredSandboxes.delete(key);
}

export function markExpired(key: string): void {
  busySandboxes.delete(key);
  expiredSandboxes.add(key);

  // Set хранит порядок вставки — вычёркиваем самое старое имя.
  if (expiredSandboxes.size > EXPIRED_LIMIT) {
    const oldest = expiredSandboxes.values().next().value;
    if (oldest !== undefined) expiredSandboxes.delete(oldest);
  }
}
