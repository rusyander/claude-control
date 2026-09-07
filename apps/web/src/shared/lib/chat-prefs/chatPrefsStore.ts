/**
 * Настройки чата, которые должны переживать перезагрузку страницы. Раньше
 * тумблер «Разрешить правки» жил в React-state и слетал при обновлении — теперь
 * его состояние хранится здесь и восстанавливается. По умолчанию правки
 * разрешены: агент свободно пишет файлы и не встаёт по мелочи.
 */

const STORAGE_KEY = 'agentdeck:chat-prefs';

/**
 * Версия сохранённого набора. Нужна ровно для одного: сменить ДЕФОЛТ у тех, кто
 * панелью уже пользовался. Хранилище пишется целиком на любую правку, поэтому у
 * старого пользователя лежит `autoApprove: false` — не его выбор, а прежний
 * дефолт, и без версии новый дефолт не дошёл бы ни до кого, кроме чистого
 * браузера. Переход на версию 2 (07.09.2026) включает автоподтверждение один
 * раз; выключенное ПОСЛЕ него уже сохраняется и переживает перезагрузку.
 */
const PREFS_VERSION = 2;

export interface ChatPrefs {
  /** Разрешать агенту править файлы (acceptEdits). По умолчанию — да. */
  allowEdits: boolean;
  /** Звук уведомлений (агент ждёт ответа, упал или закончил). По умолчанию — да. */
  sound: boolean;
  /**
   * Громкость уведомлений как множитель базового тона: 1 = исходные 100%,
   * 2 = вдвое громче. По умолчанию 2 — базовый синтезированный сигнал слишком
   * тихий, чтобы услышать его из другой комнаты или поверх музыки.
   */
  soundVolume: number;
  /**
   * Подтверждать безопасные запросы прав самой панелью. По умолчанию — ДА
   * (решение владельца, 07.09.2026): выключенным тумблером панель встречала
   * каждого нового человека карточкой «Разрешить» на любой чих, и первым же
   * действием его всё равно включали. Кому нужен разбор поштучно — выключает
   * один раз, положение переживает перезагрузку.
   */
  autoApprove: boolean;
}

/** Границы громкости: тише 0 не бывает, выше 4× сигнал начинает хрипеть. */
export const MIN_SOUND_VOLUME = 0;
export const MAX_SOUND_VOLUME = 4;
export const DEFAULT_SOUND_VOLUME = 2;

const DEFAULT: ChatPrefs = {
  allowEdits: true,
  sound: true,
  soundVolume: DEFAULT_SOUND_VOLUME,
  autoApprove: true,
};

/** Привести громкость к допустимому диапазону; мусор из хранилища → дефолт. */
export function clampVolume(raw: unknown): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_SOUND_VOLUME;
  return Math.min(MAX_SOUND_VOLUME, Math.max(MIN_SOUND_VOLUME, value));
}

export function sanitizePrefs(raw: unknown): ChatPrefs {
  const source = (raw ?? {}) as Partial<ChatPrefs> & { version?: number };
  // Набор из прежней версии: положение автоподтверждения в нём — не выбор
  // человека, а старый дефолт, поэтому берём новый.
  const isCurrent = source.version === PREFS_VERSION;

  return {
    allowEdits: typeof source.allowEdits === 'boolean' ? source.allowEdits : true,
    sound: typeof source.sound === 'boolean' ? source.sound : true,
    soundVolume: clampVolume(source.soundVolume),
    autoApprove: isCurrent ? source.autoApprove !== false : true,
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
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...prefs, version: PREFS_VERSION }),
    );
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

export function setAutoApprove(autoApprove: boolean): void {
  if (prefs.autoApprove === autoApprove) return;
  prefs = { ...prefs, autoApprove };
  persist(prefs);
  emit();
}

export function setSound(sound: boolean): void {
  if (prefs.sound === sound) return;
  prefs = { ...prefs, sound };
  persist(prefs);
  emit();
}

export function setSoundVolume(volume: number): void {
  const next = clampVolume(volume);
  if (prefs.soundVolume === next) return;
  prefs = { ...prefs, soundVolume: next };
  persist(prefs);
  emit();
}
