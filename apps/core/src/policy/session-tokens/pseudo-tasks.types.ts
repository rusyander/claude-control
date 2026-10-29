/** `pseudo.json` псевдозадачи: чья она (предок-CLI) и когда выпущена. */
export interface PseudoRecord {
  v: 1;
  taskId: string;
  ancestor: { pid: number; start: string; image?: string };
  createdAt: number;
}

export type PseudoAnswer = { taskId: string; created: boolean } | { outside: string };

export interface PseudoTasks {
  /** Задача проверки по процессу-звонящему: предок-CLI → его псевдозадача; иначе причина «вне очереди». */
  resolve(caller: { pid: number; pidStart: number }): Promise<PseudoAnswer>;
  /** Строка в `capture.log` псевдозадачи (вопрос, ответ, итог). */
  note(taskId: string, data: Record<string, unknown>): void;
  dirOf(taskId: string): string;
}
