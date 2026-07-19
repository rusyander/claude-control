import { useEffect, useState } from 'react';

/** Как часто задвигаем новый сэмпл в дорожку (мс). Меньше — быстрее «бежит» волна. */
const PUSH_INTERVAL_MS = 55;
/** Усиление RMS, чтобы обычная речь давала заметную высоту. */
const GAIN = 3.2;
/** Минимальная высота столбца (тонкая линия в тишине, а не пустота). */
const FLOOR = 0.04;

/**
 * Бегущая звуковая дорожка с РЕАЛЬНОГО микрофона (AudioContext + AnalyserNode) для
 * голосового ввода. Возвращает скользящее окно громкости во ВРЕМЕНИ длиной `bars`:
 * новый сэмпл (текущая громкость, RMS по time-domain) добавляется СПРАВА, окно
 * сдвигается влево → визуально волна течёт справа налево. Чем громче — тем выше
 * правый столбец. Пока `active=false` (или нет доступа) — окно нулевое (плоская линия).
 */
export function useMicLevels(active: boolean, bars = 40): number[] {
  const [levels, setLevels] = useState<number[]>(() => new Array<number>(bars).fill(0));

  useEffect(() => {
    // Неактивно: ничего не считаем (VoiceWave при остановке размонтируется, так что
    // прежние значения не видны); новый старт перезапишет дорожку с нуля.
    if (!active) {
      return undefined;
    }
    // eslint-disable-next-line no-restricted-syntax -- DOM feature-detection: navigator.mediaDevices вне базовых типов
    const media = (navigator as unknown as { mediaDevices?: MediaDevices }).mediaDevices;
    // eslint-disable-next-line no-restricted-syntax -- DOM feature-detection: webkitAudioContext вне стандартных типов
    const scope = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AudioCtx = scope.AudioContext ?? scope.webkitAudioContext;
    if (media === undefined || AudioCtx === undefined) {
      return undefined;
    }

    let raf = 0;
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let cancelled = false;
    // Скользящее окно громкости во времени (newest — справа).
    const history = new Array<number>(bars).fill(0);
    let lastPush = 0;

    const tick = (analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>, now: number): void => {
      if (cancelled) {
        return;
      }
      // Time-domain → настоящая амплитуда (громкость), а не частотный спектр.
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (const sample of data) {
        const centered = (sample - 128) / 128;
        sumSquares += centered * centered;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      const level = Math.max(FLOOR, Math.min(1, rms * GAIN));

      // Задвигаем новый сэмпл не каждый кадр, а по интервалу — так волна «бежит»
      // с приятной скоростью независимо от частоты кадров.
      if (now - lastPush >= PUSH_INTERVAL_MS) {
        lastPush = now;
        history.shift();
        history.push(level);
        setLevels([...history]);
      }
      raf = requestAnimationFrame((next) => {
        tick(analyser, data, next);
      });
    };

    media
      .getUserMedia({ audio: true })
      .then((granted) => {
        if (cancelled) {
          granted.getTracks().forEach((track) => {
            track.stop();
          });
          return;
        }
        stream = granted;
        ctx = new AudioCtx();
        const source = ctx.createMediaStreamSource(granted);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const buffer = new Uint8Array(analyser.fftSize);
        raf = requestAnimationFrame((now) => {
          tick(analyser, buffer, now);
        });
      })
      .catch(() => {
        // Отказ в доступе/ошибка — дорожка остаётся плоской (ошибку покажет хук речи).
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((track) => {
        track.stop();
      });
      void ctx?.close();
      // Сброс к плоскому состоянию, чтобы следующее открытие диктовки выглядело так же,
      // как первое (без «хвоста» волны от прошлой сессии). Сброс в cleanup, а не в теле
      // эффекта, — компонент-владелец (VoiceComposer) при этом смонтирован.
      setLevels(new Array<number>(bars).fill(0));
    };
  }, [active, bars]);

  return levels;
}
