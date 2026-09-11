import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import styles from './help-kit.module.scss';
import type { HelpDiagramProps } from './help-kit.types';

/**
 * Схема в справке. Живёт в том же каталоге, что и снимки, и по тому же правилу:
 * `apps/web/public/help/<раздел>/diagrams/<имя>.png`, подпись —
 * `help.diagrams.<раздел>.<имя>`.
 *
 * Картинка, а не вектор, и это решение, а не лень: подписи в схемах собраны
 * разметкой (`html=1` в draw.io), viewer выводит их через `foreignObject`, а
 * браузер не рисует его содержимое внутри `<img>`. SVG приехал бы сюда без
 * единой буквы. Исходник схемы — `.drawio` в `docs/diagrams/`, экспорт делает
 * `node tools/help-shots/diagrams.mjs`.
 *
 * Белый фон внутри картинки, а не под ней: схема нарисована тёмным по светлому
 * и на тёмной теме иначе потеряла бы текст.
 *
 * Схема шире колонки документа и ужимается до неё, поэтому картинка — ссылка на
 * саму себя: в колонке видно устройство, а подписи читаются в отдельной вкладке
 * в натуральную величину. Снимку экрана такая ссылка не нужна — он снят под ту
 * же ширину, в которой и показан.
 */
export function HelpDiagram({ topic, name }: HelpDiagramProps) {
  const { t } = useTranslation();
  const caption = t(`help.diagrams.${topic}.${name}`);
  const src = `/help/${topic}/diagrams/${name}.png`;

  return (
    <figure className={`${styles.shot} ${styles.diagram}`}>
      <a
        className={styles.diagramLink}
        href={src}
        target="_blank"
        rel="noreferrer"
        title={t('help.diagrams.open')}
      >
        <img className={styles.shotImage} src={src} alt={caption} loading="lazy" />
      </a>
      <figcaption className={styles.shotCaption}>
        <Typography variant="caption" color="muted" as="span">
          {t('help.diagrams.label')} · {caption} · {t('help.diagrams.open')}
        </Typography>
      </figcaption>
    </figure>
  );
}
