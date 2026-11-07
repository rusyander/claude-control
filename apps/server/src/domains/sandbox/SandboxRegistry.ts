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

/**
 * Срок успокоения после прогона. Ход разговора кончился и поток закрыт, а CLI ещё выходит:
 * ядро закрывает сеанс через секунду-две после хода, и всё это время процесс стоит в `work`
 * текущей папкой — на Windows такую папку не стереть (EBUSY).
 */
export const SANDBOX_SETTLE_MS = 10_000;

/** Когда в песочнице кончился последний прогон. */
const freedAt = new Map<string, number>();

export function markSandboxFree(id: string): void {
  const key = sandboxKey(id);
  busySandboxes.delete(key);
  freedAt.set(key, Date.now());
}

/** Сколько ещё длится успокоение после прогона, мс; прогона не было или срок вышел — 0. */
export function sandboxSettleLeft(id: string, now = Date.now()): number {
  const at = freedAt.get(sandboxKey(id));
  return at === undefined ? 0 : Math.max(0, at + SANDBOX_SETTLE_MS - now);
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
  freedAt.delete(key);
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
