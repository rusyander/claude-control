// Провайдер распознавания речи. UI/хук зависят ТОЛЬКО от этого интерфейса:
// сейчас WebSpeechProvider (Web Speech API), в будущем — ServerSttProvider (стрим
// аудио на бэк). Замена не трогает UI (ТЗ №3 §5, шов под бэк).

/** Категории ошибок распознавания (нормализованные, независимы от движка). */
export type SpeechErrorKind = 'no-permission' | 'no-speech' | 'network' | 'aborted' | 'unsupported';

export interface SpeechProvider {
  /** Доступно ли распознавание в этом окружении. */
  isSupported(): boolean;
  /** Начать слушать на указанном языке (например, ru-RU). */
  start(lang: string): void;
  /** Остановить распознавание. */
  stop(): void;
  /** Промежуточный (interim) транскрипт — печатается в реальном времени. */
  onPartial(cb: (text: string) => void): void;
  /** Итоговый распознанный текст. */
  onFinal(cb: (text: string) => void): void;
  /** Ошибка распознавания/доступа. */
  onError(cb: (error: SpeechErrorKind) => void): void;
  /** Распознавание завершилось (микрофон отпущен). */
  onEnd(cb: () => void): void;
}
