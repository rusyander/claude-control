import type { SpeechErrorKind, SpeechProvider } from './speech-provider';

// Минимальные типы Web Speech API (нет в стандартных lib.dom для webkit-префикса).
interface SpeechAlternativeLike {
  transcript: string;
}
interface SpeechResultLike {
  0: SpeechAlternativeLike;
  isFinal: boolean;
}
interface SpeechResultEventLike {
  results: ArrayLike<SpeechResultLike>;
}
interface SpeechErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechErrorEventLike) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  // eslint-disable-next-line no-restricted-syntax -- DOM feature-detection: webkitSpeechRecognition вне стандартных типов
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/** Нормализует код ошибки Web Speech API в наши категории. */
function mapError(code: string): SpeechErrorKind {
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return 'no-permission';
  }
  if (code === 'no-speech') {
    return 'no-speech';
  }
  if (code === 'network') {
    return 'network';
  }
  if (code === 'aborted') {
    return 'aborted';
  }
  return 'no-speech';
}

/** Реализация SpeechProvider поверх Web Speech API (браузер/мобильный WebView). */
export class WebSpeechProvider implements SpeechProvider {
  private recognition: SpeechRecognitionLike | null = null;
  private partialCb: ((text: string) => void) | null = null;
  private finalCb: ((text: string) => void) | null = null;
  private errorCb: ((error: SpeechErrorKind) => void) | null = null;
  private endCb: (() => void) | null = null;

  isSupported(): boolean {
    return getCtor() !== undefined;
  }

  start(lang: string): void {
    const Ctor = getCtor();
    if (Ctor === undefined) {
      this.errorCb?.('unsupported');
      return;
    }
    // Полностью отвязываем прошлую сессию перед стартом новой: её событие onend не
    // должно протечь в наши колбэки — иначе авто-рестарт «по тишине» при явном
    // перезапуске микрофона устроил бы повторный старт (а с синхронным onend — рекурсию).
    const previous = this.recognition;
    if (previous !== null) {
      previous.onresult = null;
      previous.onend = null;
      previous.onerror = null;
      previous.stop();
    }
    // Конфигурируем новый объект ДО сохранения в ref (правило иммутабельности).
    const recognition = new Ctor();
    recognition.lang = lang;
    // continuous: диктовка длинными фразами с паузами (как в ChatGPT). Браузер всё
    // равно может оборвать сессию по тишине — хук авто-перезапускает, пока слушаем.
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let partial = '';
      let final = '';
      for (const result of Array.from(event.results)) {
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          partial += result[0].transcript;
        }
      }
      // ВСЕГДА сообщаем partial (в т.ч. пустой): когда фраза финализируется, interim
      // становится '' — без этого хук держал бы старый interim, дублируя последнюю фразу.
      this.partialCb?.(partial);
      if (final !== '') {
        this.finalCb?.(final);
      }
    };
    recognition.onerror = (event) => {
      this.errorCb?.(mapError(event.error));
    };
    recognition.onend = () => {
      this.endCb?.();
    };
    this.recognition = recognition;
    try {
      recognition.start();
    } catch {
      // Повторный start или окружение без доступа — сообщаем ошибкой, не роняем UI.
      this.errorCb?.('aborted');
    }
  }

  stop(): void {
    this.recognition?.stop();
  }

  onPartial(cb: (text: string) => void): void {
    this.partialCb = cb;
  }

  onFinal(cb: (text: string) => void): void {
    this.finalCb = cb;
  }

  onError(cb: (error: SpeechErrorKind) => void): void {
    this.errorCb = cb;
  }

  onEnd(cb: () => void): void {
    this.endCb = cb;
  }
}
