/**
 * Короткий звук уведомления — чтобы услышать, что агент ждёт ответа, упал или
 * закончил, не глядя в экран. Тон синтезируем через Web Audio: никаких файлов,
 * и каждый повод звучит по-своему.
 *
 * Тонкости: AudioContext до первого жеста пользователя может быть «suspended» —
 * пробуем разбудить его. Если Web Audio недоступен (нет окна, старый браузер) —
 * молча ничего не делаем: звук приятен, но не обязателен.
 */

export type NotifyKind = 'waiting' | 'error' | 'done';

let audioContext: AudioContext | undefined;

function getContext(): AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return undefined;
  audioContext ??= new Ctor();
  return audioContext;
}

/**
 * Потолок пика: громкость приходит извне множителем (настройка чата), но выше
 * ~0.5 Web Audio клиппирует и вместо сигнала слышен хрип. Ограничение живёт
 * здесь, а не в настройке: в настройке — желание человека, здесь — физика.
 */
const MAX_PEAK = 0.5;

/** Одна нота с мягкой атакой и затуханием, чтобы не щёлкало. */
function beep(
  ac: AudioContext,
  frequency: number,
  startOffset: number,
  duration: number,
  volume: number,
  type: OscillatorType = 'sine',
  basePeak = 0.08,
): void {
  const peak = Math.min(MAX_PEAK, basePeak * volume);
  if (peak <= 0) return;
  const oscillator = ac.createOscillator();
  const gain = ac.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  oscillator.connect(gain);
  gain.connect(ac.destination);

  const startAt = ac.currentTime + startOffset;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

/**
 * Проиграть уведомление. Разные поводы — разный мотив:
 *   waiting — две восходящие ноты, «нужен ты»;
 *   error   — низкий пилообразный сигнал, «что-то сломалось»;
 *   done    — короткая приятная трель, «готово».
 */
export function playNotification(kind: NotifyKind, volume = 1): void {
  const ac = getContext();
  if (!ac) return;
  if (ac.state === 'suspended') void ac.resume().catch(() => undefined);

  if (kind === 'waiting') {
    beep(ac, 660, 0, 0.12, volume);
    beep(ac, 880, 0.13, 0.17, volume);
  } else if (kind === 'error') {
    beep(ac, 300, 0, 0.18, volume, 'sawtooth', 0.06);
    beep(ac, 200, 0.17, 0.24, volume, 'sawtooth', 0.06);
  } else {
    beep(ac, 720, 0, 0.1, volume);
    beep(ac, 960, 0.1, 0.18, volume);
  }
}
