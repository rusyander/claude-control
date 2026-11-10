import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { composerChips, useComposerChips } from '../../model/composerChips';
import styles from './ComposerChips.module.scss';

/**
 * Чипы описаний над полем ввода (выбранный элемент сайта): что уйдёт агенту вместе с текстом.
 * Каждый снимается крестиком; пусто — места не занимает.
 */
export function ComposerChips() {
  const { t } = useTranslation();
  const chips = useComposerChips();
  if (chips.length === 0) return null;

  return (
    <Stack
      direction="row"
      wrap
      gap="var(--spacing-2xs)"
      padding="var(--spacing-xs) var(--spacing-md) 0"
      data-composer-chips
    >
      {chips.map((chip) => (
        <Stack
          as="span"
          key={chip.id}
          direction="row"
          align="center"
          gap="var(--spacing-3xs)"
          className={styles.chip}
          title={chip.title}
          data-composer-chip
        >
          <Icon name="search" size={14} />
          <span className={styles.label}>{chip.label}</span>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="close" size={14} />}
            aria-label={`${t('common.delete')}: ${chip.label}`}
            onClick={() => composerChips.remove(chip.id)}
          />
        </Stack>
      ))}
    </Stack>
  );
}
