import { useState } from 'react';
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
 * ЯЗЫК КАДРА. Переводилась только подпись, а на картинке оставался русский
 * интерфейс: английскому читателю такая пара не объясняет ничего — подпись
 * называет кнопку одним словом, а на снимке написано другое. Английский кадр
 * лежит РЯДОМ с русским и называется `<кадр>.en.png`: съёмка кладёт его в ту же
 * папку и в ту же опись, и сторож `tools/qa/check-help-shots.mjs` видит его тем
 * же плоским списком PNG, каким видит русский, — без второго обхода каталога.
 *
 * ПРОПУСК ЗАКРЫВАЕТСЯ САМ. Английских кадров пока меньше, чем русских, и
 * переснимаются они разделами. Пока раздел не переснят, `onError` подставляет
 * русский файл: читатель видит снимок не на своём языке — это хуже перевода, но
 * несравнимо лучше битой картинки посреди инструкции. Неудачный адрес
 * запоминается, а не выставляется флаг «сломано»: как только язык (а с ним и
 * желаемый адрес) меняется, попытка повторяется сама — без эффекта и без
 * ключа-пересборки.
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
  const caption = t(`help.shots.${topic}.${scenario}.${frame}`);

  const russian = `/help/${topic}/${scenario}/${frame}.png`;
  const wanted = i18n.language.startsWith('en') ? `${russian.slice(0, -4)}.en.png` : russian;
  const [broken, setBroken] = useState('');
  const src = broken === wanted ? russian : wanted;

  return (
    <figure className={styles.shot}>
      <img
        className={styles.shotImage}
        src={src}
        alt={caption}
        loading="lazy"
        onError={() => setBroken(wanted)}
      />
      <figcaption className={styles.shotCaption}>
        <Typography variant="caption" color="muted" as="span">
          {side === 'enterprise-platform' ? t('help.shots.sideEnterprisePlatform') : t('help.shots.sidePanel')} · {caption}
        </Typography>
      </figcaption>
    </figure>
  );
}
