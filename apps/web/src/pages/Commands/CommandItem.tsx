import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { sourceTone } from './CommandItem.lib';
import type { CommandItemProps } from './CommandItem.types';
import styles from './CommandsPage.module.scss';

/** Одна строка списка команд: как вызывается, чья она и где лежит. */
export function CommandItem({ row, onOpen }: CommandItemProps) {
  const { t } = useTranslation();
  const canOpen = row.target !== 'none' && Boolean(row.targetId);

  return (
    <Stack
      direction="row"
      align="start"
      justify="between"
      gap="var(--spacing-sm)"
      className={styles.row}
      data-command={row.invocation}
    >
      <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="mono" weight="medium" as="span">
            {row.invocation}
          </Typography>
          {row.argumentHint && (
            <Typography variant="mono" color="subtle" as="span" className={styles.hint}>
              {row.argumentHint}
            </Typography>
          )}

          <Badge tone={sourceTone(row)}>{t(`commands.source.${row.source}`)}</Badge>
          {/* «Bundled skill» и связка агентов ведут себя иначе обычной команды:
              их Claude может позвать сам, поэтому тип видно сразу. */}
          {row.builtinKind && row.builtinKind !== 'builtin' && (
            <Badge tone="info">{t(`commands.kind.${row.builtinKind}`)}</Badge>
          )}
          {row.isRemoved && <Badge tone="danger">{t('commands.removed')}</Badge>}
          {!row.isEnabled && !row.isRemoved && (
            <Badge tone="warning">{t('commands.disabled')}</Badge>
          )}
        </Stack>

        {row.description && (
          <Typography variant="caption" color="subtle" className={styles.description}>
            {row.description}
          </Typography>
        )}

        <Stack direction="row" gap="var(--spacing-sm)" wrap className={styles.meta}>
          {row.owner && (
            <Typography variant="caption" color="subtle" as="span">
              {t('commands.owner')}: {row.owner}
            </Typography>
          )}
          {row.aliases.length > 0 && (
            <Typography variant="caption" color="subtle" as="span">
              {t('commands.aliases')}: {row.aliases.map((alias) => `/${alias}`).join(', ')}
            </Typography>
          )}
        </Stack>

        {/* Семья — ответ на «с чем эта команда ходит парой»: соседи по префиксу
            имени или по плагину. */}
        {row.family.length > 0 && (
          <Typography variant="caption" color="subtle" as="span" className={styles.line}>
            {t('commands.family')}: {row.family.join(', ')}
          </Typography>
        )}

        {row.related.length > 0 && (
          <Typography variant="caption" color="subtle" as="span" className={styles.line}>
            {t('commands.related')}: {row.related.map((name) => `/${name}`).join(', ')}
          </Typography>
        )}

        {row.path && (
          <Typography variant="caption" color="subtle" as="span" className={styles.path}>
            {row.path}
          </Typography>
        )}
      </Stack>

      {canOpen && (
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<Icon name="edit" size={18} />}
          onClick={onOpen}
        >
          {t('commands.open')}
        </Button>
      )}
    </Stack>
  );
}
