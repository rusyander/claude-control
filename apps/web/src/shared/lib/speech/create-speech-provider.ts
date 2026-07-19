import type { SpeechProvider } from './speech-provider';
import { WebSpeechProvider } from './web-speech-provider';

/** Заглушка, когда реальное распознавание выключено флагом (или ждём серверный STT). */
class DisabledSpeechProvider implements SpeechProvider {
  isSupported(): boolean {
    return false;
  }
  start(): void {
    /* распознавание отключено */
  }
  stop(): void {
    /* распознавание отключено */
  }
  onPartial(): void {
    /* событий нет */
  }
  onFinal(): void {
    /* событий нет */
  }
  onError(): void {
    /* событий нет */
  }
  onEnd(): void {
    /* событий нет */
  }
}

/**
 * Фабрика провайдера речи: единственная точка выбора реализации. Сейчас —
 * Web Speech API браузера, серверное распознавание подключается здесь же,
 * не трогая интерфейс.
 *
 * Заглушка нужна для окружений без Web Speech: там кнопка микрофона просто
 * не появится, а не сломает форму.
 */
export function createSpeechProvider(): SpeechProvider {
  const hasWebSpeech =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  return hasWebSpeech ? new WebSpeechProvider() : new DisabledSpeechProvider();
}
