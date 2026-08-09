import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { dict, useLanguage } from '../config/i18n';

/**
 * Голосовой ввод. Распознаёт система телефона — своей записи и отправки звука на
 * сервер здесь нет намеренно: голос ушёл бы за пределы машины, а весь смысл
 * панели в том, что данные остаются дома.
 *
 * Промежуточный результат отдаётся сразу: человек должен видеть, что его
 * слышат, — иначе он говорит в тишину и не понимает, работает ли вообще.
 *
 * Отказ здесь не авария: клавиатура на месте. Поэтому причина возвращается
 * текстом, а не бросается исключением.
 */

export interface VoiceInput {
  listening: boolean;
  /** Почему не слушаем — это и есть ответ человеку. Пусто, если всё хорошо. */
  problem: string;
  toggle: () => void;
}

export function useVoice(onText: (text: string) => void): VoiceInput {
  const language = useLanguage();
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState('');
  // Слушатель события живёт дольше одного нажатия, а колбэк приходит новый на
  // каждый ввод символа: без ссылки он застыл бы на первом.
  const sink = useRef(onText);
  sink.current = onText;

  useSpeechRecognitionEvent('result', (event) => {
    const transcript = event.results?.[0]?.transcript ?? '';
    if (transcript) sink.current(transcript);
  });
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('error', (event) => {
    setListening(false);
    // `no-speech` — человек промолчал; ругаться на это незачем.
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    setProblem(event.message || dict().composer.voiceUnavailable);
  });

  const toggle = useCallback(() => {
    if (listening) {
      // Гасим индикатор сразу, не дожидаясь `end`: распознаватель обрабатывает
      // хвост записи ещё пару секунд, а бывает, что события конца не присылает
      // вовсе — тогда «Слушаю…» осталось бы на экране навсегда.
      setListening(false);
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    setProblem('');
    void (async () => {
      // На Android распознавание бывает не установлено вовсе (эмулятор без
      // сервисов Google, урезанная прошивка) — тогда `start` молча ничего не
      // делает, и человек жмёт в пустоту.
      if (
        Platform.OS === 'android' &&
        ExpoSpeechRecognitionModule.getSpeechRecognitionServices().length === 0
      ) {
        setProblem(dict().composer.voiceUnavailable);
        return;
      }
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        setProblem(dict().composer.voiceDenied);
        return;
      }
      setListening(true);
      ExpoSpeechRecognitionModule.start({
        lang: language === 'ru' ? 'ru-RU' : 'en-US',
        interimResults: true,
        continuous: false,
      });
    })();
  }, [listening, language]);

  return { listening, problem, toggle };
}
