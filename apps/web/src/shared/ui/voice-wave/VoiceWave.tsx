import { useReducedMotion } from '@shared/hooks/use-reduced-motion';
import { cn } from '@shared/lib/cn';

import styles from './VoiceWave.module.scss';
import type { VoiceWaveProps } from './VoiceWave.types';

/** Ниже этого уровня считаем, что тишина → показываем «дышащую» idle-волну. */
const IDLE_LEVEL = 0.1;

/**
 * Бегущая звуковая дорожка: столбцы РАВНОМЕРНО заполняют всю ширину (flex:1), высота
 * каждого = громкость в этот момент. Новый сэмпл входит справа, окно сдвигается влево →
 * волна течёт справа налево (CSS-transition сглаживает сдвиг), громче = выше.
 *
 * Пустое состояние (тишина) — НЕ мёртвая пунктирная линия, а мягкая «дышащая» волна,
 * бегущая справа налево (CSS-анимация со сдвигом фазы по столбцам). reduced-motion —
 * статичные тонкие столбцы.
 */
export function VoiceWave({ levels, active, className }: VoiceWaveProps) {
  const reduced = useReducedMotion();
  const idle = active && levels.every((level) => level <= IDLE_LEVEL);
  const animateIdle = idle && !reduced;

  return (
    <div className={cn(styles.wave, animateIdle && styles.idle, className)} aria-hidden="true">
      {levels.map((level, index) =>
        animateIdle ? (
          <span
            // Отрицательный сдвиг фазы по индексу → «дышащая» волна бежит справа налево.
            key={index}
            className={styles.bar}
            style={{ animationDelay: `${(index * -0.06).toFixed(2)}s` }}
          />
        ) : (
          <span
            key={index}
            className={styles.bar}
            style={{ transform: `scaleY(${String(reduced ? 0.18 : Math.max(0.06, level))})` }}
          />
        ),
      )}
    </div>
  );
}
