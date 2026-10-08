import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { DeleteButton } from '@features/EntityDelete';
import {
  useAddProviderMarketplace,
  useRemoveProviderMarketplace,
  useUpgradeProviderMarketplace,
} from '@entities/ProviderPlugins';
import type { ProviderCodexMarketplacesProps } from './ProviderCodexMarketplaces.types';
import styles from './ProviderCodexMarketplaces.module.scss';

/**
 * Рынки плагинов Codex (MAP 25): список подключённых и форма «подключить». Всё
 * идёт командами `codex plugin marketplace …` на сервере; «Обновить снимок»
 * имеет смысл только у git-рынка, но CLI сам отвечает, что обновлять нечего, —
 * панель не угадывает вид рынка по его пути.
 */
export function ProviderCodexMarketplaces({ marketplaces }: ProviderCodexMarketplacesProps) {
  const { t } = useTranslation();
  const add = useAddProviderMarketplace();
  const upgrade = useUpgradeProviderMarketplace();
  const remove = useRemoveProviderMarketplace();
  const [source, setSource] = useState('');

  const trimmed = source.trim();
  // Те же правила, что у сервера: флаг в начале или вторая строка не уйдут в CLI.
  const invalid = trimmed.startsWith('-') || /[\r\n]/.test(source);
  const busy = add.isPending || upgrade.isPending || remove.isPending;

  const submit = (): void => {
    if (!trimmed || invalid) return;
    add.mutate(trimmed, { onSuccess: () => setSource('') });
  };

  return (
    <Card padding="sm">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          {t('providerPlugins.codex.marketplacesTitle')}
        </Typography>

        {marketplaces.length === 0 ? (
          <Typography variant="body-sm" color="subtle">
            {t('providerPlugins.codex.marketplacesEmpty')}
          </Typography>
        ) : (
          <Stack gap="var(--spacing-xs)">
            {marketplaces.map((market) => (
              <Stack key={market.name} direction="row" align="center" gap="var(--spacing-xs)" wrap>
                <Typography variant="body" weight="medium">
                  {market.name}
                </Typography>
                {market.root && (
                  <Typography variant="mono" color="subtle" as="span" truncate>
                    {market.root}
                  </Typography>
                )}
                <Stack direction="row" gap="var(--spacing-2xs)" className={styles.rowActions}>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    isLoading={upgrade.isPending && upgrade.variables === market.name}
                    onClick={() => upgrade.mutate(market.name)}
                    aria-label={`${t('providerPlugins.codex.upgrade')}: ${market.name}`}
                  >
                    {t('providerPlugins.codex.upgrade')}
                  </Button>
                  <DeleteButton
                    entityName={market.name}
                    description={t('providerPlugins.codex.removeMarketplaceConfirm')}
                    onDelete={() => remove.mutate(market.name)}
                    isPending={remove.isPending}
                  />
                </Stack>
              </Stack>
            ))}
          </Stack>
        )}

        <TextField
          label={t('providerPlugins.codex.marketplaceSourceLabel')}
          value={source}
          onChange={setSource}
          placeholder="owner/repo"
          isMono
          hint={t('providerPlugins.codex.marketplaceSourceHint')}
          error={invalid ? t('providerPlugins.codex.marketplaceSourceInvalid') : undefined}
          disabled={add.isPending}
        />
        <Stack direction="row" justify="end">
          <Button
            onClick={submit}
            disabled={!trimmed || invalid}
            isLoading={add.isPending}
            leftIcon={<Icon name="plus" size={16} />}
          >
            {add.isPending
              ? t('providerPlugins.codex.adding')
              : t('providerPlugins.codex.addMarketplace')}
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}
