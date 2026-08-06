import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EndpointApiKind } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import {
  ENDPOINT_API_KINDS,
  ENDPOINT_BASE_URL_SAMPLE,
  useSaveEndpointToken,
  useClearEndpointToken,
} from '@entities/Endpoint';
import { SettingToggleRow } from './SettingToggleRow';
import type { EndpointProfileFormProps } from './EndpointProfileForm.types';

/**
 * Поля одного профиля: имя, адрес, вид API, модель и токен.
 *
 * Токен живёт отдельно от остальных полей и сохраняется своей кнопкой: он не
 * часть настроек, а секрет в зашифрованном хранилище панели, и обратно наружу
 * приходит только маской. Галочка «писать токен в конфигурацию» рядом с ним —
 * там же, где предупреждение, чего она стоит.
 */
export function EndpointProfileForm({
  profile,
  tokenMask,
  probe,
  onChange,
}: EndpointProfileFormProps) {
  const { t } = useTranslation();
  const saveToken = useSaveEndpointToken();
  const clearToken = useClearEndpointToken();
  const [token, setToken] = useState('');

  const apiKindOptions = ENDPOINT_API_KINDS.map((kind) => ({
    value: kind,
    label: t(`endpoints.apiKind.${kind}`),
  }));

  // Модели с адреса появляются после проверки связи. Пока их нет — обычное
  // поле ввода: имя модели у локального сервера человек знает и сам, а
  // выпадающий список из одного своего значения только мешает.
  const models = probe?.models ?? [];

  const submitToken = (): void => {
    const trimmed = token.trim();
    if (!trimmed) return;
    saveToken.mutate({ profileId: profile.id, token: trimmed }, { onSuccess: () => setToken('') });
  };

  return (
    <Stack gap="var(--spacing-sm)">
      <TextField
        label={t('endpoints.name')}
        value={profile.name}
        onChange={(name) => onChange({ ...profile, name })}
      />

      <SelectField
        label={t('endpoints.apiKindLabel')}
        value={profile.apiKind}
        onChange={(value) => onChange({ ...profile, apiKind: value as EndpointApiKind })}
        options={apiKindOptions}
        hint={t('endpoints.apiKindHint')}
      />

      <TextField
        label={t('endpoints.baseUrl')}
        value={profile.baseUrl}
        onChange={(baseUrl) => onChange({ ...profile, baseUrl })}
        placeholder={ENDPOINT_BASE_URL_SAMPLE[profile.apiKind]}
        isMono
        hint={t(`endpoints.baseUrlHint.${profile.apiKind}`)}
      />

      {models.length > 0 ? (
        <SelectField
          label={t('endpoints.model')}
          value={profile.model}
          onChange={(model) => onChange({ ...profile, model })}
          options={[
            { value: '', label: t('endpoints.modelAuto') },
            ...models.map((id) => ({ value: id, label: id })),
          ]}
          hint={t('endpoints.modelHint')}
        />
      ) : (
        <TextField
          label={t('endpoints.model')}
          value={profile.model}
          onChange={(model) => onChange({ ...profile, model })}
          isMono
          hint={t('endpoints.modelHint')}
        />
      )}

      <Stack gap="var(--spacing-2xs)">
        <Stack direction="row" align="end" gap="var(--spacing-xs)" wrap>
          <Stack flex={1} minWidth="220px">
            <TextField
              label={t('endpoints.token')}
              type="password"
              value={token}
              onChange={setToken}
              placeholder={tokenMask || t('endpoints.tokenPlaceholder')}
            />
          </Stack>
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Icon name="check" size={18} />}
            onClick={submitToken}
            disabled={!token.trim()}
            isLoading={saveToken.isPending}
          >
            {t('common.save')}
          </Button>
          {tokenMask && (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="trash" size={18} />}
              onClick={() => clearToken.mutate(profile.id)}
              isLoading={clearToken.isPending}
            >
              {t('endpoints.tokenClear')}
            </Button>
          )}
        </Stack>
        <Typography variant="caption" color="subtle">
          {t('endpoints.tokenHint')}
        </Typography>
      </Stack>

      <SettingToggleRow
        label={t('endpoints.writeToken')}
        hint={t('endpoints.writeTokenHint')}
        checked={profile.writeToken}
        onChange={(writeToken) => onChange({ ...profile, writeToken })}
      />
    </Stack>
  );
}
