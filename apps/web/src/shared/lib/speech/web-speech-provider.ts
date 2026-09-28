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
  onstart?: (() => void) | null;
  onaudiostart?: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  // DOM feature-detection: webkitSpeechRecognition вне стандартных типов.
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
  // Устройства записи нет или оно занято: раньше пряталось в молчаливое
  // 'no-speech', и кнопка просто гасла без объяснения.
  if (code === 'audio-capture') {
    return 'no-microphone';
  }
  return 'no-speech';
}

/**
 * Сколько ждать первого события распознавателя после start. Chromium без
 * микрофона (и без службы распознавания) не присылает НИЧЕГО: ни start, ни
 * ошибки, ни конца — окно стояло в «Говорите…», а «Отправить» ждала диктовку
 * вечно. Живой распознаватель отвечает `start` за доли секунды; запас — на
 * вопрос браузера о доступе к микрофону.
 */
export const START_WATCHDOG_MS = 15_000;

/**
 * Сколько всего ждать ответа человека на вопрос о микрофоне (F-335). Без предела
 * нельзя: без устройства записи Chromium вопроса не показывает, а `state` так и
 * остаётся 'prompt' — окно снова стояло бы в «Говорите…» вечно.
 */
export const PROMPT_GRACE_MS = 60_000;

/** Сколько ждать конца сессии после stop: без ответа микрофон отпускаем сами. */
export const STOP_WATCHDOG_MS = 3_000;

/**
 * Состояние доступа к микрофону — живой объект: `state` меняется сам, когда
 * человек отвечает на вопрос браузера. Нет Permissions API или имени
 * `microphone` (Firefox) — `undefined`, сторож работает по прежнему сроку.
 */
function watchMicPermission(): Promise<PermissionStatus | undefined> {
  try {
    const permissions = typeof navigator === 'undefined' ? undefined : navigator.permissions;
    if (!permissions?.query) return Promise.resolve(undefined);
    return permissions
      .query({ name: 'microphone' as PermissionName })
      .then((status) => status)
      .catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

function detach(recognition: SpeechRecognitionLike): void {
  recognition.onresult = null;
  recognition.onend = null;
  recognition.onerror = null;
  recognition.onstart = null;
  recognition.onaudiostart = null;
}

/** Реализация SpeechProvider поверх Web Speech API (браузер/мобильный WebView). */
export class WebSpeechProvider implements SpeechProvider {
  private recognition: SpeechRecognitionLike | null = null;
  private partialCb: ((text: string) => void) | null = null;
  private finalCb: ((text: string) => void) | null = null;
  private errorCb: ((error: SpeechErrorKind) => void) | null = null;
  private endCb: (() => void) | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /** Сессия, которой уже сказали stop: ждём её конца, а не первого события. */
  private stopping: SpeechRecognitionLike | null = null;
  /** Доступ к микрофону (живой объект), если браузер его отдаёт. */
  private micPermission: PermissionStatus | undefined;

  private disarm(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /** Распознаватель не ответил вовремя: отпускаем его и говорим, чем кончилось. */
  private arm(
    ms: number,
    recognition: SpeechRecognitionLike,
    error?: SpeechErrorKind,
    promptUntil?: number,
  ): void {
    this.disarm();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.recognition !== recognition) return;
      // Сторож старта, а браузер ещё спрашивает человека о микрофоне: Chromium
      // шлёт `start` только после ответа, и медленный ответ превращался в «нет
      // микрофона» с остановленной сессией (F-335). Ждём ещё — до PROMPT_GRACE_MS.
      const left = promptUntil === undefined ? 0 : promptUntil - Date.now();
      if (error && this.micPermission?.state === 'prompt' && left > 0) {
        this.arm(Math.min(ms, left), recognition, error, promptUntil);
        return;
      }
      detach(recognition);
      this.recognition = null;
      try {
        recognition.stop();
      } catch {
        // уже остановлен
      }
      if (error) this.errorCb?.(error);
      this.endCb?.();
    }, ms);
  }

  isSupported(): boolean {
    return getCtor() !== undefined;
  }

  /**
   * Хук ушёл со страницы: сессия остановлена, сторожа сняты, колбэки забыты.
   * `stop()` здесь не годился — он ставит сторож конца, и тот через 3 с звал
   * колбэки уже размонтированного хука (F-342).
   */
  dispose(): void {
    this.disarm();
    const recognition = this.recognition;
    this.recognition = null;
    this.stopping = null;
    if (recognition !== null) {
      detach(recognition);
      try {
        recognition.stop();
      } catch {
        // уже остановлен
      }
    }
    this.partialCb = null;
    this.finalCb = null;
    this.errorCb = null;
    this.endCb = null;
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
    this.disarm();
    if (previous !== null) {
      detach(previous);
      previous.stop();
    }
    // Конфигурируем новый объект ДО сохранения в ref (правило иммутабельности).
    const recognition = new Ctor();
    recognition.lang = lang;
    // continuous: диктовка длинными фразами с паузами (как в ChatGPT). Браузер всё
    // равно может оборвать сессию по тишине — хук авто-перезапускает, пока слушаем.
    recognition.continuous = true;
    recognition.interimResults = true;
    // Любое событие — распознаватель жив, сторож старта больше не нужен.
    recognition.onstart = () => this.disarm();
    recognition.onaudiostart = () => this.disarm();
    recognition.onresult = (event) => {
      if (this.watchdog !== null && this.stopping !== recognition) this.disarm();
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
      if (this.stopping !== recognition) this.disarm();
      this.errorCb?.(mapError(event.error));
    };
    recognition.onend = () => {
      this.disarm();
      this.stopping = null;
      if (this.recognition === recognition) this.recognition = null;
      this.endCb?.();
    };
    this.recognition = recognition;
    this.stopping = null;
    if (this.micPermission === undefined) {
      void watchMicPermission().then((status) => {
        this.micPermission = status;
      });
    }
    try {
      recognition.start();
      this.arm(START_WATCHDOG_MS, recognition, 'no-microphone', Date.now() + PROMPT_GRACE_MS);
    } catch {
      // Повторный start или окружение без доступа — сообщаем ошибкой, не роняем UI.
      this.errorCb?.('aborted');
    }
  }

  stop(): void {
    const recognition = this.recognition;
    if (recognition === null) return;
    this.stopping = recognition;
    recognition.stop();
    // Конец сессии не пришёл — «Перевожу речь…» не должно висеть вечно.
    this.arm(STOP_WATCHDOG_MS, recognition);
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
