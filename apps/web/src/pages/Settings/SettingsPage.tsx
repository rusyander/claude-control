import { useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AppSettings } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { SelectField } from '@shared/ui/select-field';
import { apiClient } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import {
  MODEL_OPTIONS,
  EFFORT_LEVELS,
  modelLabel,
  modelSelectOptions,
  withCurrentValue,
} from '@shared/lib/chat-model';
import { ACCENT_OPTIONS, accentLabelKey } from '@shared/lib/accent';
import { useSettings, useUpdateSettings } from '@entities/AppConfig';
import { useModelCatalog } from '@entities/ModelCatalog';
import { AccountCard } from './AccountCard';
import { ClaudeDirField } from './ClaudeDirField';
import { CredentialsCard } from './CredentialsCard';
import { EditorCard } from './EditorCard';
import { RemoteAccessCard } from './RemoteAccessCard';
import { PricingCard } from './PricingCard';
import { BackupsCard } from './BackupsCard';
import { EnvTransferCard } from './EnvTransferCard';
import { SecretEncryptionCard } from './SecretEncryptionCard';
import { SettingToggleRow } from './SettingToggleRow';
import { NumberSettingRow } from './NumberSettingRow';
import { ProviderSelectorCard } from './ProviderSelectorCard';
import { ProviderCheckCard } from './ProviderCheckCard';
import { ProviderKeysCard } from './ProviderKeysCard';
import { ModelCatalogCard } from './ModelCatalogCard';
import { EndpointCard } from './EndpointCard';
import { FormatCheckCard } from './FormatCheckCard';
import styles from './SettingsPage.module.scss';

/** Настройки приложения: оформление, доступность, путь к конфигурации, безопасность правок. */
export function SettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const { data: modelCatalog } = useModelCatalog();
  const updateSettings = useUpdateSettings();
  const fileRef = useRef<HTMLInputElement>(null);

  if (!settings) return <SkeletonList rows={4} withActions={false} />;

  const patch = (change: Partial<AppSettings>): void => {
    updateSettings.mutate(change);
  };

  // Алиасы CLI плюс конкретные модели из каталога провайдера: зашитый список
  // устаревал молча, а каталог знает и о вышедших вчера.
  const modelOptions = withCurrentValue(
    modelSelectOptions(modelCatalog?.models ?? [], MODEL_OPTIONS, (value) =>
      value ? modelLabel(value) : t('settings.chatModelAuto'),
    ),
    settings.chatModel,
  );
  const effortOptions = EFFORT_LEVELS.map((level) => ({
    value: level,
    label: level ? t(`chat.effort_${level}`) : t('settings.chatEffortAuto'),
  }));

  // Перенос настроек панели: снимок state.json скачивается файлом и вливается
  // обратно на другой машине — раньше это делали только копированием руками.
  const exportState = async (): Promise<void> => {
    const { data } = await apiClient.get('/settings/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'claude-control-settings.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const importState = async (file: File): Promise<void> => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      await apiClient.post('/settings/import', parsed);
      await queryClient.invalidateQueries();
      toast.success(t('settings.transferImported'));
    } catch {
      toast.error(t('settings.transferImportError'));
    }
  };

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
        helpTopic="settings"
      />

      <AccountCard />

      <ProviderSelectorCard />

      <ProviderCheckCard />

      <ProviderKeysCard />

      {/* Сверка форматов чужих CLI со схемами: рядом с проверкой провайдера —
          оба отвечают на вопрос «можно ли доверять записи в чужой конфиг». */}
      <FormatCheckCard />

      <ClaudeDirField />

      <CredentialsCard />

      {/* Удалённый доступ стоит сразу за доступом к аккаунту: обе карточки про
          то, кого панель пускает, — только одна про модель, а вторая про людей. */}
      <RemoteAccessCard />

      <EditorCard />

      <Card padding="md">
        <Stack gap="var(--spacing-md)">
          <Typography variant="body" weight="medium">
            {t('settings.theme')}
          </Typography>

          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            {(['light', 'dark', 'system'] as const).map((theme) => (
              <Button
                key={theme}
                variant={settings.theme === theme ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => patch({ theme })}
              >
                {t(`settings.theme${theme[0]?.toUpperCase()}${theme.slice(1)}`)}
              </Button>
            ))}
          </Stack>

          <Typography variant="body" weight="medium">
            {t('settings.accent')}
          </Typography>
          <Typography variant="body-sm" color="subtle">
            {t('settings.accentHint')}
          </Typography>

          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            {ACCENT_OPTIONS.map((accent) => (
              <Button
                key={accent}
                variant={settings.accent === accent ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => patch({ accent })}
              >
                {t(accentLabelKey(accent))}
              </Button>
            ))}
          </Stack>

          <Typography variant="body" weight="medium">
            {t('settings.language')}
          </Typography>

          <Stack direction="row" gap="var(--spacing-xs)">
            {(['ru', 'en'] as const).map((language) => (
              <Button
                key={language}
                variant={settings.language === language ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => patch({ language })}
              >
                {language === 'ru' ? 'Русский' : 'English'}
              </Button>
            ))}
          </Stack>
        </Stack>
      </Card>

      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('settings.spendTitle')}
          </Typography>

          <SettingToggleRow
            label={t('settings.spendMoney')}
            hint={t('settings.spendHint')}
            checked={settings.costUnit === 'money'}
            onChange={(inMoney) => patch({ costUnit: inMoney ? 'money' : 'tokens' })}
          />
        </Stack>
      </Card>

      {/* Модель и глубина по умолчанию для чата — централизованно здесь; в самом
          чате их можно переопределить локально для одного разговора. */}
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('settings.chatDefaultsTitle')}
          </Typography>
          <Typography variant="body-sm" color="subtle">
            {t('settings.chatDefaultsHint')}
          </Typography>

          <SelectField
            label={t('settings.chatModel')}
            value={settings.chatModel}
            onChange={(chatModel) => patch({ chatModel })}
            options={modelOptions}
            hint={t('settings.chatModelHint')}
          />
          <SelectField
            label={t('settings.chatEffort')}
            value={settings.chatEffort}
            onChange={(value) => patch({ chatEffort: value as AppSettings['chatEffort'] })}
            options={effortOptions}
            hint={t('settings.chatEffortHint')}
          />
        </Stack>
      </Card>

      {/* Каталог моделей провайдера: он же питает выпадающий список выше. */}
      <ModelCatalogCard />

      {/* Свой эндпоинт: адрес модели вместо облака вендора. Сразу за каталогом
          моделей — оба про то, откуда берутся ответы. */}
      <EndpointCard />

      {/* MCP: автопроверка связи при открытии раздела и потолок ожидания сети. */}
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('settings.mcpTitle')}
          </Typography>

          <SettingToggleRow
            label={t('settings.mcpAutoCheck')}
            hint={t('settings.mcpAutoCheckHint')}
            checked={settings.mcpAutoCheck}
            onChange={(mcpAutoCheck) => patch({ mcpAutoCheck })}
          />
          <NumberSettingRow
            label={t('settings.mcpTimeout')}
            hint={t('settings.mcpTimeoutHint')}
            value={settings.mcpNetworkTimeoutMs}
            min={2000}
            max={120000}
            step={500}
            inputClassName={styles.numberInput}
            hintClassName={styles.hint}
            onChange={(mcpNetworkTimeoutMs) => patch({ mcpNetworkTimeoutMs })}
          />
        </Stack>
      </Card>

      {/* Тарифы показываем рядом с переключателем единиц: они про одно и то же. */}
      <PricingCard />

      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('settings.accessibility')}
          </Typography>

          <SettingToggleRow
            label={t('settings.largeText')}
            hint={t('settings.largeTextHint')}
            checked={settings.largeText}
            onChange={(largeText) => patch({ largeText })}
          />
          <SettingToggleRow
            label={t('settings.reduceMotion')}
            hint={t('settings.reduceMotionHint')}
            checked={settings.reduceMotion}
            onChange={(reduceMotion) => patch({ reduceMotion })}
          />
          <SettingToggleRow
            label={t('settings.highContrast')}
            hint={t('settings.highContrastHint')}
            checked={settings.highContrast}
            onChange={(highContrast) => patch({ highContrast })}
          />
        </Stack>
      </Card>

      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('settings.safety')}
          </Typography>

          <SettingToggleRow
            label={t('settings.backupBeforeWrite')}
            hint={t('settings.backupHint')}
            checked={settings.backupBeforeWrite}
            onChange={(backupBeforeWrite) => patch({ backupBeforeWrite })}
          />
          <SettingToggleRow
            label={t('settings.previewProviderWrites')}
            hint={t('settings.previewProviderWritesHint')}
            checked={settings.previewProviderWrites}
            onChange={(previewProviderWrites) => patch({ previewProviderWrites })}
          />
          <NumberSettingRow
            label={t('settings.backupKeep')}
            hint={t('settings.backupKeepHint')}
            value={settings.backupKeep}
            min={1}
            max={100}
            inputClassName={styles.numberInput}
            onChange={(backupKeep) => patch({ backupKeep })}
          />
          <SettingToggleRow
            label={t('settings.watchFiles')}
            hint={t('settings.watchHint')}
            checked={settings.watchFiles}
            onChange={(watchFiles) => patch({ watchFiles })}
          />
          <SettingToggleRow
            label={t('settings.revealSecrets')}
            hint={t('settings.revealSecretsHint')}
            checked={settings.revealSecretsByDefault}
            onChange={(revealSecretsByDefault) => patch({ revealSecretsByDefault })}
          />
        </Stack>
      </Card>

      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('settings.transferTitle')}
          </Typography>
          <Typography variant="body-sm" color="subtle" className={styles.hint}>
            {t('settings.transferHint')}
          </Typography>
          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="file" size={18} />}
              onClick={() => void exportState()}
            >
              {t('settings.transferExport')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="file" size={18} />}
              onClick={() => fileRef.current?.click()}
            >
              {t('settings.transferImport')}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importState(file);
                event.target.value = '';
              }}
            />
          </Stack>
        </Stack>
      </Card>

      {/* Перенос окружения: конфигурация ЛЮБОГО провайдера архивом на другую
          машину. Шире бандла ниже (тот про правила/скиллы/хуки Claude), поэтому
          стоит первым — обычно нужен именно он. */}
      <EnvTransferCard />

      {/* Бандл конфигурации: правила + скиллы + хуки одним файлом. Рядом с
          переносом настроек панели, но это другое — реальные файлы Claude Code. */}

      {/* Шифрование копий секретов: держим рядом с самими копиями. */}
      <SecretEncryptionCard />

      {/* Сразу под тумблером резервных копий: там их включают, здесь — применяют. */}
      <BackupsCard />
    </Stack>
  );
}
