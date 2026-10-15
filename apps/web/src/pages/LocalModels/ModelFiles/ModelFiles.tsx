import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { toGb } from '@entities/LocalModels';
import { formatGb, quantTitle } from '../ModelSelects/optionText';
import styles from './ModelFiles.module.scss';
import type { ModelFilesProps } from './ModelFiles.types';

/**
 * «На диске» в острове «Запуск»: каждое скачанное квантование строкой — имя, размер и корзина.
 * Квантование, которое держит сервер моделей, вместо корзины несёт подпись «остановите сервер»:
 * удаление сервер не останавливает. У ссылки на файл Ollama подпись говорит, что место не
 * освободится — сами байты остаются у Ollama.
 */
export function ModelFiles({ row, onRemove }: ModelFilesProps) {
  const { t, i18n } = useTranslation();
  if (row.downloaded.length === 0) return null;
  return (
    <div
      className={styles.files}
      role="group"
      aria-label={t('localModels.catalog.files.group', { title: row.model.title })}
    >
      <Typography variant="caption" color="muted" weight="semibold">
        {t('localModels.catalog.files.title')}
      </Typography>
      <ul className={styles.list}>
        {row.downloaded.map((file) => {
          const quant = quantTitle(row.model, file.quant, t);
          const size = formatGb(toGb(file.sizeBytes), i18n.language);
          const freed = formatGb(toGb(file.freesBytes), i18n.language);
          return (
            <li key={file.quant} className={styles.item}>
              <span className={styles.name}>
                <Typography as="span" variant="body-sm">
                  {`${quant} · ${t('localModels.gb', { value: size })}`}
                </Typography>
                {file.source === 'ollama' ? (
                  <Typography as="span" variant="caption" color="muted">
                    {t('localModels.catalog.files.ollama')}
                  </Typography>
                ) : null}
              </span>
              {file.loaded ? (
                <Typography as="span" variant="caption" color="muted">
                  {t('localModels.catalog.files.loaded')}
                </Typography>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="trash" />}
                  aria-label={t('localModels.catalog.files.remove', { quant, size: freed })}
                  title={t('localModels.catalog.files.remove', { quant, size: freed })}
                  onClick={() => onRemove(file)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
