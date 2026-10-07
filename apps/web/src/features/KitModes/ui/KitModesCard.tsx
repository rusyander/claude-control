import { useTranslation } from 'react-i18next';
import { kitItemKinds, type KitProviderView } from '@agentdeck/contracts/kit';
import type { KitMode } from '@agentdeck/contracts/local-models';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { SelectField } from '@shared/ui/select-field';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { useSetKitProviderMode } from '@entities/Kit';
import type { KitModesCardProps } from './KitModesCard.types';
import styles from './KitModesCard.module.scss';

/**
 * Кто получает набор: режим на каждый CLI. Тот, кому набор не подключить на один
 * запуск, виден строкой с причиной — молча пропущенный читался бы как «работает».
 */
export function KitModesCard({ providers, footer }: KitModesCardProps) {
  const { t } = useTranslation();
  const setMode = useSetKitProviderMode();

  const change = (provider: string, mode: string): void =>
    setMode.mutate(
      { provider, mode: mode as KitMode },
      {
        onSuccess: () => toast.success(t('kit.modes.saved')),
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );

  const supported = providers.filter((provider) => provider.modes.length > 0);
  const reasons = Object.entries(
    providers
      .filter((provider) => provider.modes.length === 0)
      .reduce<Record<string, string[]>>((acc, provider) => {
        const reason = provider.reason ?? 'no-run-layer';
        (acc[reason] ??= []).push(provider.title);
        return acc;
      }, {}),
  );

  /** Набор доходит частично (Codex: правила и навыки) — сказать, что именно не доедет. */
  const carriesNote = (provider: KitProviderView): string => {
    if (!provider.carries || provider.mode === 'global') return '';
    const carried = provider.carries;
    const missing = kitItemKinds.filter((kind) => !carried.includes(kind));
    if (missing.length === 0) return '';
    const names = (kinds: readonly string[]): string =>
      kinds.map((kind) => t(`kit.modes.carriesKind.${kind}`)).join(', ');
    return t('kit.modes.carries', {
      carried: names(carried),
      missing: names(missing),
      title: provider.title,
    });
  };

  const row = (provider: KitProviderView) => (
    <Stack key={provider.id} gap="var(--spacing-2xs)" minWidth="16rem" flex={1}>
      <SelectField
        label={provider.title}
        value={provider.mode}
        options={provider.modes.map((mode) => ({
          value: mode,
          label: t(`kit.modes.mode.${mode}`),
        }))}
        onChange={(mode) => change(provider.id, mode)}
        hint={[
          t(`kit.modes.hint.${provider.mode}`),
          provider.localOnly ? t('kit.modes.localOnly') : '',
          carriesNote(provider),
        ]
          .filter(Boolean)
          .join(' ')}
      />
    </Stack>
  );

  return (
    <Card padding="md" role="region" aria-label={t('kit.modes.title')}>
      <Stack gap="var(--spacing-md)">
        <Stack gap="var(--spacing-xs)">
          <Typography variant="heading-sm" as="h2">
            {t('kit.modes.title')}
          </Typography>
          <Typography variant="body-sm" color="muted">
            {t('kit.modes.what')}
          </Typography>
        </Stack>
        <Stack direction="row" gap="var(--spacing-md)" wrap>
          {supported.map(row)}
        </Stack>
        {/* Одна строка на причину, а не на CLI: восемь одинаковых фраз прятали
            под собой вкладки набора. */}
        {reasons.map(([reason, titles]) => (
          <Typography key={reason} variant="body-sm" color="subtle">
            <span className={styles.cross} aria-hidden="true">
              ×
            </span>{' '}
            {t(`kit.modes.unsupported.${reason}`, { list: titles.join(', ') })}
          </Typography>
        ))}
        {footer}
      </Stack>
    </Card>
  );
}
