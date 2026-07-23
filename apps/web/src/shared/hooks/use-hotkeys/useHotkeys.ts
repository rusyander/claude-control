import { useEffect, useRef } from 'react';
import {
  isEditableTarget,
  matchSequence,
  parseChord,
  type HotkeyBinding,
  type KeyStep,
} from '@shared/lib/hotkeys';

/** Через сколько после последнего нажатия буфер последовательности сбрасывается. */
const SEQUENCE_TIMEOUT = 1000;

/**
 * Глобальные горячие клавиши. Слушает нажатия на окне, копит короткую
 * последовательность и вызывает обработчик, чей аккорд лёг в её конец.
 *
 * Что важно:
 *  - последовательности (`g o`) собираются с таймаутом: пауза очищает буфер;
 *  - в полях ввода срабатывают только аккорды с модификатором (`mod+k`), чтобы
 *    набор текста не запускал переходы — если явно не разрешено `allowInInput`;
 *  - привязки читаются через ref, поэтому подписка на окно не пересоздаётся на
 *    каждый рендер, а обработчики всегда актуальны.
 */
export function useHotkeys(bindings: HotkeyBinding[]): void {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    let buffer: KeyStep[] = [];
    let lastAt = 0;

    const onKeyDown = (event: KeyboardEvent): void => {
      // Само нажатие модификатора шагом не считаем — иначе буфер копил бы «ctrl».
      if (['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) return;

      const now = Date.now();
      if (now - lastAt > SEQUENCE_TIMEOUT) buffer = [];
      lastAt = now;

      const step: KeyStep = {
        key: event.key.toLowerCase(),
        mod: event.ctrlKey || event.metaKey,
      };
      buffer = [...buffer, step].slice(-8);

      const editable = isEditableTarget(event.target);

      for (const binding of bindingsRef.current) {
        const steps = parseChord(binding.chord);
        if (steps.length === 0) continue;

        // В поле ввода простые аккорды молчат: пусть текст набирается спокойно.
        const usesMod = steps.some((item) => item.mod);
        if (editable && !usesMod && !binding.allowInInput) continue;

        if (matchSequence(buffer, steps)) {
          event.preventDefault();
          buffer = [];
          binding.handler();
          break;
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
