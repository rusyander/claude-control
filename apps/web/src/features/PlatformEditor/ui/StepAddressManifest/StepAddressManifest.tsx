import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PLATFORM_PRESETS,
  isManifestEndpointPath,
  isManifestVendorPrefix,
  isManifestWirePath,
  platformManifestDeclared,
  type PlatformClientTools,
  type PlatformManifestOverrides,
} from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Icon } from '@shared/ui/icon';
import type { WizardStepProps } from '../PlatformWizard.types';
import styles from './StepAddressManifest.module.scss';
import { manifestWithField } from '../../model/manifestWithField';
import { effortMode } from '../../lib/effortMode';
import { ManifestPath } from './ManifestPath/ManifestPath';
import { ManifestTimeout } from './ManifestTimeout/ManifestTimeout';

/**
 * Что умеет шлюз поверх пресета (DRV-03): родная ручка Anthropic, ручка
 * картинок, поле размышлений, инструменты, усилие, предел цельного ответа.
 *
 * Свёрнуто, пока переопределений нет: пресет уже объявил сверенное с
 * документацией, и шесть полей на первом шаге читались бы как обязательные.
 * Рядом с каждым выбором стоит, ЧТО объявил пресет, — «как у пресета» без
 * значения человеку ничего не говорит.
 */
export function StepAddressManifest({ model }: WizardStepProps) {
  const { t } = useTranslation();
  const { driver, manifest } = model.draft;
  const declared = platformManifestDeclared(driver);
  const [initiallyOpen] = useState(() => Object.keys(manifest ?? {}).length > 0);

  const set = <F extends keyof PlatformManifestOverrides>(
    field: F,
    value: PlatformManifestOverrides[F] | undefined,
  ): void => model.patch({ manifest: manifestWithField(manifest, field, value) });

  const shown = (value: string): string => value || t('platform.manifest.notDeclared');

  return (
    <details className={styles.transport} open={initiallyOpen}>
      <summary className={styles.transportSummary}>
        <Icon name="chevronRight" size={16} className={styles.chevron} />
        <Typography variant="body-sm" as="span">
          {t('platform.manifest.summary')}
        </Typography>
      </summary>
      <Stack gap="var(--spacing-md)" className={styles.transportBody}>
        <Typography variant="caption" color="muted">
          {t('platform.manifest.intro')}
        </Typography>
        <Typography variant="caption" color="muted">
          {t('platform.manifest.source', { source: PLATFORM_PRESETS[driver].source })}
        </Typography>

        <ManifestPath
          key={`anthropic-${driver}`}
          label={t('platform.manifest.anthropicLabel')}
          hint={t('platform.manifest.anthropicHint')}
          presetValue={shown(declared.anthropicMessages)}
          sample="messages"
          value={manifest?.anthropicMessages}
          valid={isManifestEndpointPath}
          error={t('platform.manifest.pathError')}
          onChange={(value) => set('anthropicMessages', value)}
        />
        <ManifestPath
          key={`images-${driver}`}
          label={t('platform.manifest.imagesLabel')}
          hint={t('platform.manifest.imagesHint')}
          presetValue={
            declared.imagesInChat ? t('platform.manifest.imagesInChat') : shown(declared.imagesApi)
          }
          sample="images/generations"
          value={manifest?.imagesApi}
          valid={isManifestEndpointPath}
          error={t('platform.manifest.pathError')}
          onChange={(value) => set('imagesApi', value)}
        />
        <ManifestPath
          key={`thinking-${driver}`}
          label={t('platform.manifest.thinkingLabel')}
          hint={t('platform.manifest.thinkingHint')}
          presetValue={shown(declared.thinkingField)}
          sample="enable_thinking"
          value={manifest?.thinkingField}
          valid={isManifestWirePath}
          error={t('platform.manifest.wireError')}
          onChange={(value) => set('thinkingField', value)}
        />

        {declared.vendorPrefix !== '' && (
          <TextField
            key={`prefix-${driver}`}
            label={t('platform.manifest.prefixLabel')}
            value={manifest?.vendorPrefix ?? ''}
            onChange={(next) => set('vendorPrefix', next.trim() === '' ? undefined : next.trim())}
            placeholder={declared.vendorPrefix}
            isMono
            hint={t('platform.manifest.prefixHint', {
              value: manifest?.vendorPrefix ?? declared.vendorPrefix,
            })}
            error={
              manifest?.vendorPrefix === undefined || isManifestVendorPrefix(manifest.vendorPrefix)
                ? undefined
                : t('platform.manifest.prefixError')
            }
          />
        )}

        <Stack direction="row" gap="var(--spacing-md)" wrap>
          <div className={styles.transportCell}>
            <SelectField
              label={t('platform.manifest.toolsLabel')}
              value={manifest?.clientTools ?? 'preset'}
              onChange={(value) =>
                set('clientTools', value === 'preset' ? undefined : (value as PlatformClientTools))
              }
              options={[
                {
                  value: 'preset',
                  label: t('platform.manifest.asPreset', {
                    value: t(`platform.manifest.tools.${declared.clientTools}`),
                  }),
                },
                { value: 'native', label: t('platform.manifest.tools.native') },
                {
                  value: 'native-no-call',
                  label: t('platform.manifest.tools.native-no-call'),
                },
                { value: 'shim', label: t('platform.manifest.tools.shim') },
              ]}
              hint={t('platform.manifest.toolsHint')}
            />
          </div>
          <div className={styles.transportCell}>
            <SelectField
              label={t('platform.manifest.effortLabel')}
              value={effortMode(manifest?.effort)}
              onChange={(value) => set('effort', value === 'preset' ? undefined : value === 'on')}
              options={[
                {
                  value: 'preset',
                  label: t('platform.manifest.asPreset', {
                    value: t(`platform.manifest.effort.${declared.effort ? 'on' : 'off'}`),
                  }),
                },
                { value: 'on', label: t('platform.manifest.effort.on') },
                { value: 'off', label: t('platform.manifest.effort.off') },
              ]}
              hint={t('platform.manifest.effortHint')}
            />
          </div>
        </Stack>

        <ManifestTimeout
          key={`timeout-${driver}`}
          label={t('platform.manifest.timeoutLabel')}
          hint={(value) => t('platform.manifest.timeoutHint', { value })}
          presetValue={
            declared.nonStreamTimeoutSec > 0
              ? String(declared.nonStreamTimeoutSec)
              : t('platform.manifest.timeoutNone')
          }
          value={manifest?.nonStreamTimeoutSec}
          onChange={(value) => set('nonStreamTimeoutSec', value)}
        />
        <ManifestTimeout
          key={`ceiling-${driver}`}
          label={t('platform.manifest.ceilingLabel')}
          hint={(value) => t('platform.manifest.ceilingHint', { value })}
          presetValue={
            declared.responseCeilingSec > 0
              ? String(declared.responseCeilingSec)
              : t('platform.manifest.timeoutNone')
          }
          value={manifest?.responseCeilingSec}
          onChange={(value) => set('responseCeilingSec', value)}
        />
      </Stack>
    </details>
  );
}
