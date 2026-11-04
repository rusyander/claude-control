import { createHash, randomBytes } from 'node:crypto';

/**
 * Токены моста сессии (этап 10, F2, проход 2c). Ход агента панели идёт сессией ядра; её инструменты
 * — процесс `tools/mcp/panel.mjs`, и ключ от всей панели ему не нужен. Панель выдаёт на ход свой
 * токен, ядро кладёт его только в окружение моста, мост шлёт его заголовком
 * `x-agentdeck-bridge-token`. Токен годен ТОЛЬКО для `/api/agent/actions*`, только для своего
 * разговора и только пока ход жив: конец хода (ответ, ошибка, «Стоп», обрыв) его снимает.
 *
 * Сам токен не хранится — только его хеш: дамп памяти процесса или запись в журнал ключа не
 * выдают. Срок — страховка на случай, если конец хода не пришёл вовсе (панель живёт, ядро упало).
 */

export const BRIDGE_TOKEN_HEADER = 'x-agentdeck-bridge-token';
/** Дольше самого длинного хода с ожиданием карточки (10 мин) и потолка хода. */
const DEFAULT_TTL_MS = 2 * 60 * 60_000;

interface Entry {
  owner: string;
  expires: number;
  taskId?: string;
  /** Итоги действий этого хода (`panelActionNote`): память следующего хода разговора. */
  notes: string[];
}

export interface BridgeTokenLedger {
  /** Новый токен хода разговора `owner`; вернуть — передать ядру в `panelBridge.token`. */
  mint(owner: string): string;
  /** Привязка к задаче ядра, когда та названа: снятие задачи снимает и токен. */
  bind(token: string, taskId: string): void;
  /** Снять токен; вернуть итоги действий хода, записанные под ним. */
  revoke(token: string): string[];
  /** Живой ли токен; `owner` — разговор, для которого он выдан. */
  ownerOf(token: string): string | undefined;
  /** Итог действия, вызванного мостом этого токена; у мёртвого токена — ничего. */
  note(token: string, text: string): void;
  size(): number;
}

const keyOf = (token: string): string => createHash('sha256').update(token).digest('hex');

export function createBridgeTokenLedger(
  opts: { ttlMs?: number; now?: () => number } = {},
): BridgeTokenLedger {
  const entries = new Map<string, Entry>();
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const sweep = (): void => {
    const at = now();
    for (const [key, entry] of entries) if (entry.expires <= at) entries.delete(key);
  };
  return {
    mint(owner) {
      sweep();
      const token = randomBytes(32).toString('base64url');
      entries.set(keyOf(token), { owner, expires: now() + ttl, notes: [] });
      return token;
    },
    bind(token, taskId) {
      const entry = entries.get(keyOf(token));
      if (entry) entry.taskId = taskId;
    },
    revoke(token) {
      const key = keyOf(token);
      const notes = entries.get(key)?.notes ?? [];
      entries.delete(key);
      return notes;
    },
    ownerOf(token) {
      sweep();
      return entries.get(keyOf(token))?.owner;
    },
    note(token, text) {
      entries.get(keyOf(token))?.notes.push(text);
    },
    size() {
      sweep();
      return entries.size;
    },
  };
}

/** Путь действий агента панели — единственное, куда пускает токен моста. */
export function isAgentActionsPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path === '/api/agent/actions' || path.startsWith('/api/agent/actions/');
}
