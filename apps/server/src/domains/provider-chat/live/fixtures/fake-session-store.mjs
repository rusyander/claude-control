// Диск подделок CLI для сессий между ходами (E2b): настоящий CLI хранит сессию
// в своём доме и находит её другим процессом — подделка делает то же файлом
// FAKE_STORE. Нет переменной — сессии живут только в процессе, как и раньше.
// Тест читает файл после хода: какие сессии есть, что ушло в каждую, что удалено.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const file = process.env.FAKE_STORE;

export const persistent = Boolean(file);

/** { sessions: { [id]: { prompts: string[], replies: string[], ...метки } }, deleted: string[], log: string[] } */
export function load() {
  if (!file || !existsSync(file)) return { sessions: {}, deleted: [], log: [] };
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function change(apply) {
  if (!file) return;
  const state = load();
  apply(state);
  writeFileSync(file, JSON.stringify(state));
}

/** Новый id: номер — сколько сессий этот дом уже видел. */
export function nextId(prefix) {
  const state = load();
  return `${prefix}-${Object.keys(state.sessions).length + state.deleted.length + 1}`;
}

export function remove(id) {
  change((state) => {
    state.log.push(`delete ${id}`);
    if (!state.sessions[id]) return;
    delete state.sessions[id];
    state.deleted.push(id);
  });
}
