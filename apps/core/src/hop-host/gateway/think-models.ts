import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from './json-file.ts';

/**
 * Модели, пойманные на голом `</think>` (L9; замена `store.getThinkTailModels` панели): первый
 * такой ответ уже ушёл с размышлением в тексте, следующие ответы этой модели звено держит до тега.
 * Ключ — маршрут и модель: одна и та же модель у разных маршрутов бывает разной сборкой.
 */
export class ThinkTailModels {
  readonly #path: string;
  #set: Set<string>;

  constructor(stateDir: string) {
    this.#path = join(stateDir, 'think-tail.json');
    let list: unknown;
    try {
      list = readJsonFile<unknown>(this.#path, []);
    } catch {
      list = [];
    }
    this.#set = new Set(Array.isArray(list) ? list.filter((item) => typeof item === 'string') : []);
  }

  has(routeId: string, model: string): boolean {
    return this.#set.has(`${routeId}\u0000${model}`);
  }

  mark(routeId: string, model: string): void {
    const key = `${routeId}\u0000${model}`;
    if (this.#set.has(key)) return;
    this.#set.add(key);
    writeJsonFile(this.#path, [...this.#set]);
  }
}
