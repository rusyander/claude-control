/**
 * Книга токенов моста панели (этап 10, F2): токен сессии `ask`, выданный панелью, живёт ТОЛЬКО
 * в памяти ядра — от `POST /v1/ask` до конца задачи. В журнал, `state.json` и логи он не
 * попадает: дорога кладёт его лишь в окружение процесса моста и отмечает в книге ключей сеанса
 * (маска `known`). Перезапуск ядра книгу теряет — задача без токена мост не получит (отказ
 * дороги с названной причиной), а не сессию с чужим или пустым токеном.
 */

export interface AskBridgeBook {
  put(taskId: string, token: string): void;
  get(taskId: string): string | undefined;
  drop(taskId: string): void;
  /** Для проверки «токен не пережил задачу»: сколько токенов ещё держит книга. */
  size(): number;
}

export function createAskBridgeBook(): AskBridgeBook {
  const tokens = new Map<string, string>();
  return {
    put: (taskId, token) => void tokens.set(taskId, token),
    get: (taskId) => tokens.get(taskId),
    drop: (taskId) => void tokens.delete(taskId),
    size: () => tokens.size,
  };
}
