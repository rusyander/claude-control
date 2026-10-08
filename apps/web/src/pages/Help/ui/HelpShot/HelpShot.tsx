import { useTranslation } from 'react-i18next';
import { useTheme } from '@shared/hooks/use-theme';
import { Typography } from '@shared/ui/typography';
import { useShotVariants } from '../../model/useShotVariants';
import styles from './HelpShot.module.scss';
import type { HelpShotProps } from '../help-kit.types';
import { shotLangOf } from '../../model/shotLangOf';
import { pickShot } from '../../model/pickShot';
import { SIDE_KEYS } from './HelpShot.constants';

/**
 * Снимок экрана в справке.
 *
 * Каталог общий на ВСЕ разделы: `раздел → сценарий → кадр`, файлы лежат в
 * `apps/web/public/help/<раздел>/<сценарий>/` и раздаются как статика.
 * Компонент не знает ни одного конкретного кадра — он собирает адрес и ключ
 * подписи по одному правилу, поэтому новые снимки встают сюда без правки.
 *
 * ЧЕТЫРЕ ВАРИАНТА. Каждый кадр снят в светлой и тёмной теме панели, по-русски
 * и по-английски: светлый снимок на тёмной странице висит белым прямоугольником,
 * а русский интерфейс под английской подписью не объясняет ничего. Какой файл
 * какому варианту отвечает и какого он размера, знает опись раздела
 * `variants.json` — её пишет съёмка (`tools/help-shots/kit.mjs`) и сверяет
 * `tools/qa/check-help-shots.mjs`. Выбор и порядок замены недостающего варианта
 * — `pickShot` в `model/shotVariant.ts`.
 *
 * БЕЗ СКАЧКА. Размер из описи уходит в `width`/`height`: место под картинку
 * зарезервировано до загрузки, и смена темы или языка не двигает текст. Пока
 * опись не пришла, картинки нет вовсе — иначе на миг мелькнул бы чужой вариант.
 *
 * Подпись и `alt` — ОДИН текст: `help.shots.<раздел>.<сценарий>.<кадр>`.
 * Отдельная «альтернативная» формулировка разошлась бы с видимой в первый же
 * месяц, а слепому читателю нужна та же фраза, что и зрячему.
 *
 * `loading="lazy"` намеренно: путеводитель длинный, и два десятка PNG не
 * должны грузиться до того, как до них долистают.
 */
export function HelpShot({ topic, scenario, frame, side }: HelpShotProps) {
  const { t, i18n } = useTranslation();
  const { theme } = useTheme();
  const { index, settled } = useShotVariants(topic);
  const caption = t(`help.shots.${topic}.${scenario}.${frame}`);
  const shot = pickShot(index, { topic, scenario, frame }, theme, shotLangOf(i18n.language));

  return (
    <figure className={side === 'phone' ? `${styles.shot} ${styles.shotPhone}` : styles.shot}>
      {settled ? (
        <img
          className={styles.shotImage}
          src={shot.src}
          width={shot.width}
          height={shot.height}
          alt={caption}
          loading="lazy"
          data-shot={`${scenario}/${frame}`}
          data-variant={shot.variant}
        />
      ) : null}
      <figcaption className={styles.shotCaption}>
        <Typography variant="caption" color="muted" as="span">
          {t(SIDE_KEYS[side])} · {caption}
        </Typography>
      </figcaption>
    </figure>
  );
}
