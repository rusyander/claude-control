import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PLATFORM_PRESETS,
  defaultPlatformTransport,
  platformRequestUrl,
  platformTransportErrors,
  platformVersionModes,
  type PlatformTransport,
  type PlatformTransportField,
} from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Icon } from '@shared/ui/icon';
import type { WizardStepProps } from './PlatformWizard.types';
import styles from './PlatformWizard.module.scss';

/**
 * Нестандартный шлюз на шаге адреса (DRV-04/05): заголовок ключа, версия в
 * адресе, параметры и лишние заголовки.
 *
 * Свёрнуто, пока настройка стандартная: EnterprisePlatform и обычный совместимый шлюз её
 * не трогают, и пять лишних полей на первом шаге читались бы как обязательные.
 * Итоговый адрес собирается той же функцией контракта, что и на сервере, —
 * человек видит адрес, по которому пойдёт проба, ДО нажатия «Проверить связь».
 */
export function StepAddressTransport({ model }: WizardStepProps) {
  const { t } = useTranslation();
  const transport = model.draft.transport ?? defaultPlatformTransport();
  const errors = platformTransportErrors(transport);
  const preview = platformRequestUrl(model.draft.baseUrl, transport, 'models');
  // Раскрыто ли — решается ОДИН раз при открытии: управляемый `open` свернул бы
  // блок посреди правки, стоило человеку стереть последнее нестандартное поле.
  const [initiallyOpen] = useState(
    () => JSON.stringify(transport) !== JSON.stringify(defaultPlatformTransport()),
  );

  const set = (fields: Partial<PlatformTransport>): void =>
    model.patch({ transport: { ...transport, ...fields } });
  const errorOf = (field: PlatformTransportField): string | undefined => {
    const found = errors.filter((item) => item.field === field);
    return found.length > 0
      ? found
          .map((item) => t(`platform.transport.error.${item.code}`, { subject: item.subject }))
          .join('; ')
      : undefined;
  };

  return (
    <details className={styles.transport} open={initiallyOpen}>
      <summary className={styles.transportSummary}>
        <Icon name="chevronRight" size={16} className={styles.chevron} />
        <Typography variant="body-sm" as="span">
          {t('platform.transport.summary')}
        </Typography>
      </summary>
      <Stack gap="var(--spacing-md)" className={styles.transportBody}>
        <Typography variant="caption" color="muted">
          {t('platform.transport.intro')}
        </Typography>

        <SelectField
          label={t('platform.transport.versionLabel')}
          value={transport.version}
          onChange={(value) => set({ version: value as PlatformTransport['version'] })}
          options={platformVersionModes.map((mode) => ({
            value: mode,
            label: t(`platform.transport.version.${mode}`),
          }))}
        />

        <Stack direction="row" gap="var(--spacing-md)" wrap>
          <div className={styles.transportCell}>
            <TextField
              label={t('platform.transport.authHeaderLabel')}
              value={transport.authHeader}
              onChange={(value) => set({ authHeader: value })}
              placeholder={PLATFORM_PRESETS[model.draft.driver].auth?.header ?? 'Authorization'}
              isMono
              hint={t('platform.transport.authHeaderHint')}
              error={errorOf('authHeader')}
            />
          </div>
          <div className={styles.transportCell}>
            <TextField
              label={t('platform.transport.authSchemeLabel')}
              value={transport.authScheme}
              onChange={(value) => set({ authScheme: value })}
              placeholder={transport.authHeader.trim() ? '' : 'Bearer'}
              isMono
              disabled={!transport.authHeader.trim()}
              hint={t('platform.transport.authSchemeHint')}
              error={errorOf('authScheme')}
            />
          </div>
        </Stack>

        <TextField
          label={t('platform.transport.queryLabel')}
          value={transport.query}
          onChange={(value) => set({ query: value })}
          placeholder="api-version=2024-10-21"
          isMono
          hint={t('platform.transport.queryHint')}
          error={errorOf('query')}
        />

        <TextField
          label={t('platform.transport.headersLabel')}
          value={transport.headers}
          onChange={(value) => set({ headers: value })}
          placeholder="X-Tenant: research"
          multiline
          rows={2}
          isMono
          hint={t('platform.transport.headersHint')}
          error={errorOf('headers')}
        />

        <Stack gap="var(--spacing-3xs)">
          <Typography variant="caption" color="muted">
            {t('platform.transport.preview')}
          </Typography>
          <Typography variant="mono" as="code" className={styles.transportPreview}>
            {preview ?? t('platform.transport.previewNone')}
          </Typography>
        </Stack>
      </Stack>
    </details>
  );
}
