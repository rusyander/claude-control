import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import styles from './help-kit.module.scss';
import type { HelpShotProps } from './help-kit.types';

/**
 * Снимок экрана в справке.
 *
 * Каталог общий на ВСЕ разделы: `раздел → сценарий → кадр`, файлы лежат в
 * `apps/web/public/help/<раздел>/<сценарий>/<кадр>.png` и раздаются как
 * статика. Компонент не знает ни одного конкретного кадра — он собирает адрес
 * и ключ подписи по одному правилу, поэтому завтрашние снимки чата и тестов
 * встанут сюда же без единой правки.
 *
 * Подпись и `alt` — ОДИН текст: `help.shots.<раздел>.<сценарий>.<кадр>`.
 * Отдельная «альтернативная» формулировка разошлась бы с видимой в первый же
 * месяц, а слепому читателю нужна та же фраза, что и зрячему.
 *
 * `loading="lazy"` намеренно: путеводитель длинный, и два десятка PNG не
 * должны грузиться до того, как до них долистают.
 */
export function HelpShot({ topic, scenario, frame, side }: HelpShotProps) {
  const { t } = useTranslation();
  const caption = t(`help.shots.${topic}.${scenario}.${frame}`);

  return (
    <figure className={styles.shot}>
      <img
        className={styles.shotImage}
        src={`/help/${topic}/${scenario}/${frame}.png`}
        alt={caption}
        loading="lazy"
      />
      <figcaption className={styles.shotCaption}>
        <Typography variant="caption" color="muted" as="span">
          {side === 'enterprise-platform' ? t('help.shots.sideEnterprisePlatform') : t('help.shots.sidePanel')} · {caption}
        </Typography>
      </figcaption>
    </figure>
  );
}
