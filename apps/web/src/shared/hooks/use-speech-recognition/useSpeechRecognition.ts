import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { joinText } from '@shared/lib/join-text';
import { createSpeechProvider } from '@shared/lib/speech';
import type { SpeechErrorKind } from '@shared/lib/speech';

/** Состояния распознавания (ТЗ №3 §5). 'finalizing' — стоп нажат, ждём финал речь→текст (onEnd). */
export type SpeechState = 'idle' | 'listening' | 'finalizing' | 'error' | 'unsupported';

export interface SpeechRecognitionApi {
  state: SpeechState;
  /** Поддерживается ли распознавание в этом окружении. */
  supported: boolean;
  /** Идёт ли запись (state === 'listening'). */
  listening: boolean;
  /** Идёт финализация: стоп нажат, провайдер ещё переводит речь в текст (до onEnd). */
  finalizing: boolean;
  /** Накопленный распознанный текст: диктовка по фразам, с паузами (как в ChatGPT). */
  transcript: string;
  /** Текущий промежуточный фрагмент (печатается в реальном времени). */
  partial: string;
  error: SpeechErrorKind | null;
  start: () => void;
  stop: () => void;
  /** Сбросить накопленный текст (например, после отправки или при открытии оверлея). */
  reset: () => void;
}

/**
 * Реальное распознавание речи через SpeechProvider (Web Speech API) в режиме ДИКТОВКИ:
 * слушаем непрерывно, текст НАКАПЛИВАЕТСЯ по фразам, паузы допустимы (при обрыве сессии
 * по тишине авто-перезапускаем, пока пользователь не остановил). Ничего не отправляется
 * само — отправку решает UI (кнопка). Замена Web Speech на серверный STT — смена провайдера.
 */
export function useSpeechRecognition(lang: string): SpeechRecognitionApi {
  const provider = useMemo(() => createSpeechProvider(), []);
  const [supported] = useState(() => provider.isSupported());
  const [state, setState] = useState<SpeechState>(supported ? 'idle' : 'unsupported');
  const [transcript, setTranscript] = useState('');
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<SpeechErrorKind | null>(null);

  // Значения, читаемые внутри колбэков провайдера (вне рендера, поэтому в ref):
  const committedRef = useRef(''); // финалы завершённых сессий
  const sessionRef = useRef(''); // финал текущей сессии
  const wantRef = useRef(false); // пользователь хочет слушать → авто-рестарт
  const langRef = useRef(lang);

  useEffect(() => {
    langRef.current = lang;
  });

  useEffect(() => {
    provider.onPartial((text) => {
      setPartial(text);
    });
    provider.onFinal((text) => {
      // text — полный финал ТЕКУЩЕЙ сессии (провайдер собирает все isFinal результаты).
      sessionRef.current = text;
      setTranscript(joinText(committedRef.current, text));
    });
    provider.onError((kind) => {
      setError(kind);
      wantRef.current = false;
      setState('error');
    });
    provider.onEnd(() => {
      // Сессия завершилась (тишина/стоп): фиксируем её финал в committed (без двойного учёта).
      committedRef.current = joinText(committedRef.current, sessionRef.current);
      sessionRef.current = '';
      setPartial('');
      setTranscript(committedRef.current);
      if (wantRef.current) {
        provider.start(langRef.current); // авто-продолжение при долгой паузе
      } else {
        setState('idle');
      }
    });
    return () => {
      wantRef.current = false;
      provider.stop();
    };
  }, [provider]);

  const start = useCallback(() => {
    if (!supported) {
      setState('unsupported');
      return;
    }
    setError(null);
    wantRef.current = true;
    setState('listening');
    provider.start(langRef.current);
  }, [provider, supported]);

  const stop = useCallback(() => {
    wantRef.current = false;
    setState((prev) => (prev === 'listening' ? 'finalizing' : prev));
    provider.stop(); // onEnd зафиксирует финал и переведёт в idle
  }, [provider]);

  const reset = useCallback(() => {
    committedRef.current = '';
    sessionRef.current = '';
    setTranscript('');
    setPartial('');
  }, []);

  return {
    state,
    supported,
    listening: state === 'listening',
    finalizing: state === 'finalizing',
    transcript,
    partial,
    error,
    start,
    stop,
    reset,
  };
}
