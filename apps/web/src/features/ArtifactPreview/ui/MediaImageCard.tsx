import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { formatSize } from '@shared/lib/format';
import { mediaImageUrl } from '@entities/Media';
import type { MediaImageCardProps } from './ArtifactPreview.types';
import styles from './ArtifactPreview.module.scss';

/**
 * Карточка нарисованной картинки. Стоит в том же правом столбце, что и
 * предпросмотр артефакта, и намеренно им не является: артефакт — файл в папке
 * разговора, а эта картинка лежит в данных ПАНЕЛИ (в переписку Claude Code панель
 * не пишет), и адрес у неё свой.
 *
 * Скачивание — обычная ссылка с `download` на тот же адрес, которым нарисована
 * сама картинка: второй маршрут «отдай файлом» означал бы второе место, где
 * права и тип могут разойтись с первым, а на телефоне сохранение идёт средствами
 * системы по тому же адресу.
 */
export function MediaImageCard({ image, onClose }: MediaImageCardProps) {
  const { t } = useTranslation();
  const url = mediaImageUrl(image.id);
  const source = t(`chat.mode.card.source.${image.source}`);

  return (
    <Stack className={styles.panel}>
      <Stack
        direction="row"
        align="center"
        justify="between"
        gap="var(--spacing-sm)"
        className={styles.header}
      >
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body-sm" weight="medium" as="span">
            {t('chat.mode.card.title')}
          </Typography>
          <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
            <Badge tone="neutral">{t('chat.kind.image')}</Badge>
            <Typography variant="caption" color="subtle" as="span">
              {image.width && image.height
                ? t('chat.mode.card.size', {
                    width: image.width,
                    height: image.height,
                    size: formatSize(image.sizeBytes),
                  })
                : formatSize(image.sizeBytes)}
            </Typography>
            {/* Чем нарисовано — на виду: через контур и через свой эндпоинт это
                разные деньги и разные отказы. */}
            <Typography variant="caption" color="subtle" as="span">
              {image.model
                ? t('chat.mode.card.by', { model: image.model, source })
                : t('chat.mode.card.byNoModel', { source })}
            </Typography>
          </Stack>
        </Stack>

        <Stack direction="row" align="center" gap="var(--spacing-2xs)">
          <a
            href={url}
            download={image.name}
            className={styles.download}
            title={t('chat.mode.card.download')}
            aria-label={t('chat.mode.card.download')}
          >
            <Icon name="file" size={24} />
          </a>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="close" size={24} />}
            aria-label={t('common.close')}
            onClick={onClose}
          />
        </Stack>
      </Stack>

      <div className={styles.body}>
        {/* Описание человека — подпись картинки: через день по ней одной и
            понятно, что это за файл. */}
        <img src={url} alt={image.prompt} className={styles.image} />
        <Typography variant="caption" color="muted" as="p" className={styles.caption}>
          {image.prompt}
        </Typography>
      </div>
    </Stack>
  );
}
