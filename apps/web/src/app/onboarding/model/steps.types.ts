/** Хранилище может быть недоступно (приватный режим, отключённые данные сайта) — тогда молчим. */
export type StepStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
