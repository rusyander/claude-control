import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { SelectField } from '@shared/ui/select-field';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { useKitConflictWinner, useToggleKitItem } from '@entities/Kit';
import { KitGlobalActions } from './KitGlobalActions';
import { insideGlobal } from './model/globalPath';
import type { KitItemRowProps } from './KitItemRow.types';
import styles from './KitPage.module.scss';

/**
 * Строка элемента набора: что это, чьё, включено ли, как оно соотносится с
 * глобальным слоем, и действия — открыть, улучшить, перенести.
 */
export function KitItemRow({ item, globalDir, onOpen, onImprove }: KitItemRowProps) {
  const { t } = useTranslation();
  const toggle = useToggleKitItem();
  const winner = useKitConflictWinner();
  const onError = (error: unknown) => toast.error(toErrorMessage(error));

  return (
    <li className={styles.row}>
      <Stack gap="var(--spacing-xs)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body" as="h3" className={styles.name}>
              {item.name}
            </Typography>
            <Badge tone={item.origin === 'builtin' ? 'neutral' : 'info'}>
              {t(`kit.item.${item.origin}`)}
            </Badge>
          </Stack>
          <Stack direction="row" align="center" gap="var(--spacing-sm)" wrap>
            <KitGlobalActions item={item} globalDir={globalDir} />
            <Button variant="secondary" size="sm" onClick={() => onOpen(item)}>
              {t('kit.item.open')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onImprove(item)}>
              {t('kit.item.improve')}
            </Button>
            <Toggle
              checked={item.enabled}
              onCheckedChange={(enabled) => toggle.mutate({ id: item.id, enabled }, { onError })}
              aria-label={t('kit.item.enabledLabel', { name: item.name })}
            />
          </Stack>
        </Stack>
        {item.description ? (
          <Typography variant="body-sm" color="muted">
            {item.description}
          </Typography>
        ) : null}
        {item.conflict ? (
          <div className={styles.conflict}>
            <SelectField
              label={t('kit.item.conflict', {
                path: insideGlobal(item.conflict.userPath, globalDir),
              })}
              value={item.conflict.winner}
              options={(['user', 'kit'] as const).map((value) => ({
                value,
                label: t(`kit.item.winner.${value}`),
              }))}
              onChange={(value) =>
                winner.mutate({ id: item.id, winner: value as 'user' | 'kit' }, { onError })
              }
            />
          </div>
        ) : null}
      </Stack>
    </li>
  );
}
