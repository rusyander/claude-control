/**
 * Настройки чата, которые должны переживать перезагрузку страницы. Раньше
 * тумблер «Разрешить правки» жил в React-state и слетал при обновлении — теперь
 * его состояние хранится здесь и восстанавливается. По умолчанию правки
 * разрешены: агент свободно пишет файлы и не встаёт по мелочи.
 */

const STORAGE_KEY = 'claude-control:chat-prefs';

export interface ChatPrefs {
  /** Разрешать агенту править файлы (acceptEdits). По умолчанию — да. */
  allowEdits: boolean;
  /** Звук уведомлений (агент ждёт ответа, упал или закончил). По умолчанию — да. */
  sound: boolean;
}

const DEFAULT: ChatPrefs = { allowEdits: true, sound: true };

export function sanitizePrefs(raw: unknown): ChatPrefs {
  const source = (raw ?? {}) as Partial<ChatPrefs>;
  return {
    allowEdits: typeof source.allowEdits === 'boolean' ? source.allowEdits : true,
    sound: typeof source.sound === 'boolean' ? source.sound : true,
  };
}

function load(): ChatPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? sanitizePrefs(JSON.parse(raw)) : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function persist(prefs: ChatPrefs): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Приватный режим — работаем в памяти.
  }
}

let prefs: ChatPrefs = load();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getChatPrefs(): ChatPrefs {
  return prefs;
}

export function subscribeChatPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setAllowEdits(allowEdits: boolean): void {
  if (prefs.allowEdits === allowEdits) return;
  prefs = { ...prefs, allowEdits };
  persist(prefs);
  emit();
}

export function setSound(sound: boolean): void {
  if (prefs.sound === sound) return;
  prefs = { ...prefs, sound };
  persist(prefs);
  emit();
}
