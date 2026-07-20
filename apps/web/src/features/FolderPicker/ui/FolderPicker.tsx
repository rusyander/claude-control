import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SkeletonList } from '@shared/ui/skeleton';
import { useFsRoots, useFsList } from '@entities/Project';
import type { FolderPickerProps } from './FolderPicker.types';
import styles from './FolderPicker.module.scss';

/** Имя папки из пути — для подписи таба проекта. */
function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/**
 * Выбор папки проекта через файловую систему. Сверху — корни (домашняя папка и
 * диски) и переход на уровень вверх; в списке — подкаталоги. «Открыть эту папку»
 * добавляет её как проект, даже если Claude там ещё не работал.
 */
export function FolderPicker({ isOpen, onOpenChange, onPick }: FolderPickerProps) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<string | undefined>(undefined);

  // При каждом открытии начинаем с корней, а не с прошлого места.
  useEffect(() => {
    if (isOpen) setCurrent(undefined);
  }, [isOpen]);

  const roots = useFsRoots();
  const listing = useFsList(current);
  const isLoading = current ? listing.isLoading : roots.isLoading;
  const entries = current ? (listing.data?.entries ?? []) : (roots.data ?? []);
  const parent = current ? listing.data?.parent : undefined;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('folderPicker.title')}
      description={t('folderPicker.hint')}
      size="md"
      footer={
        <Stack
          direction="row"
          justify="between"
          align="center"
          gap="var(--spacing-sm)"
          width="100%"
        >
          <Typography variant="mono" color="subtle" as="span" truncate className={styles.current}>
            {current ?? t('folderPicker.roots')}
          </Typography>
          <Stack direction="row" gap="var(--spacing-xs)">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!current}
              leftIcon={<Icon name="folder" size={20} />}
              onClick={() => current && onPick(current, folderName(current))}
            >
              {t('folderPicker.pick')}
            </Button>
          </Stack>
        </Stack>
      }
    >
      <Stack direction="row" wrap gap="var(--spacing-2xs)" className={styles.roots}>
        {roots.data?.map((root) => (
          <button
            key={root.path}
            type="button"
            className={styles.chip}
            onClick={() => setCurrent(root.path)}
          >
            {root.name}
          </button>
        ))}
        {parent && (
          <button type="button" className={styles.chip} onClick={() => setCurrent(parent)}>
            <Icon name="chevronLeft" size={14} /> {t('folderPicker.up')}
          </button>
        )}
      </Stack>

      <div className={styles.list}>
        {isLoading && <SkeletonList rows={6} withActions={false} />}

        {!isLoading && entries.length === 0 && (
          <Typography variant="body-sm" color="subtle" className={styles.empty}>
            {t('folderPicker.empty')}
          </Typography>
        )}

        {entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className={styles.item}
            onClick={() => setCurrent(entry.path)}
            title={entry.path}
          >
            <Icon name="folder" size={18} />
            <Typography variant="body-sm" as="span" truncate>
              {entry.name}
            </Typography>
            <Icon name="chevronRight" size={16} />
          </button>
        ))}
      </div>
    </Modal>
  );
}
