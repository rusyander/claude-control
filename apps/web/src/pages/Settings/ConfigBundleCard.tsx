import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Modal } from '@shared/ui/modal';
import { SelectField } from '@shared/ui/select-field';
import { apiClient, toErrorMessage } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import { SettingToggleRow } from './SettingToggleRow';
import type { BundlePreview, BundleRulesMode, BundleImportSummary } from './ConfigBundleCard.types';

/** Раскладка бандла для подсчёта предпросмотра. Формат — как у серверного домена. */
interface BundleShape {
  rules?: { claudeMd?: string };
  skills?: unknown[];
  hooks?: unknown[];
}

/**
 * Бандл конфигурации — правила + скиллы + хуки одним файлом, чтобы перенести
 * настройку на другую машину или поделиться. В отличие от переноса настроек
 * панели (снимок state.json выше), здесь собираются реальные файлы Claude Code,
 * поэтому импорт меняет живую конфигурацию — с предпросмотром и подтверждением.
 */
export function ConfigBundleCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [preview, setPreview] = useState<BundlePreview | undefined>(undefined);
  const [rulesMode, setRulesMode] = useState<BundleRulesMode>('append');
  const [overwriteSkills, setOverwriteSkills] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  const exportBundle = async (): Promise<void> => {
    try {
      const { data } = await apiClient.get('/config-bundle/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'claude-control-bundle.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  };

  const openPreview = async (file: File): Promise<void> => {
    try {
      const raw: unknown = JSON.parse(await file.text());
      const shape = raw as BundleShape;
      const claudeMd = shape.rules?.claudeMd ?? '';
      setPreview({
        raw,
        rulesLines: claudeMd.trim() ? claudeMd.split('\n').length : 0,
        skills: Array.isArray(shape.skills) ? shape.skills.length : 0,
        hooks: Array.isArray(shape.hooks) ? shape.hooks.length : 0,
      });
      // Каждый импорт начинается с безопасных умолчаний: дописать правила,
      // не перезаписывать чужие скиллы.
      setRulesMode('append');
      setOverwriteSkills(false);
    } catch {
      toast.error(t('settings.bundleParseError'));
    }
  };

  const apply = async (): Promise<void> => {
    if (!preview) return;
    setIsApplying(true);
    try {
      const { data } = await apiClient.post<{ summary: BundleImportSummary }>(
        '/config-bundle/import',
        { bundle: preview.raw, options: { rulesMode, overwriteSkills } },
      );
      const summary = data.summary;
      await queryClient.invalidateQueries();
      toast.success(
        t('settings.bundleApplied', {
          skills: summary.skillsCreated.length,
          hooks: summary.hooksAdded,
        }),
      );
      setPreview(undefined);
    } catch (error) {
      toast.error(toErrorMessage(error));
    } finally {
      setIsApplying(false);
    }
  };

  const modeOptions = (['append', 'replace', 'skip'] as const).map((mode) => ({
    value: mode,
    label: t(`settings.bundleRulesMode_${mode}`),
  }));

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          {t('settings.bundleTitle')}
        </Typography>
        <Typography variant="body-sm" color="subtle" className="prose">
          {t('settings.bundleHint')}
        </Typography>

        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="file" size={18} />}
            onClick={() => void exportBundle()}
          >
            {t('settings.bundleExport')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="file" size={18} />}
            onClick={() => fileRef.current?.click()}
          >
            {t('settings.bundleImport')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void openPreview(file);
              event.target.value = '';
            }}
          />
        </Stack>
      </Stack>

      {/* Предпросмотр перед применением: сколько всего внутри и как поступить.
          Импорт меняет реальные файлы Claude Code, поэтому подтверждаем явно. */}
      <Modal
        isOpen={Boolean(preview)}
        onOpenChange={(open) => !open && setPreview(undefined)}
        title={t('settings.bundlePreviewTitle')}
        description={t('settings.bundlePreviewDesc')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPreview(undefined)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void apply()} isLoading={isApplying}>
              {t('settings.bundleApply')}
            </Button>
          </>
        }
      >
        <Stack gap="var(--spacing-md)">
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm">
              {t('settings.bundleRulesCount', { count: preview?.rulesLines ?? 0 })}
            </Typography>
            <Typography variant="body-sm">
              {t('settings.bundleSkillsCount', { count: preview?.skills ?? 0 })}
            </Typography>
            <Typography variant="body-sm">
              {t('settings.bundleHooksCount', { count: preview?.hooks ?? 0 })}
            </Typography>
          </Stack>

          <SelectField
            label={t('settings.bundleRulesModeLabel')}
            value={rulesMode}
            onChange={(value) => setRulesMode(value as BundleRulesMode)}
            options={modeOptions}
            hint={t('settings.bundleRulesModeHint')}
          />

          <SettingToggleRow
            label={t('settings.bundleOverwriteSkills')}
            hint={t('settings.bundleOverwriteSkillsHint')}
            checked={overwriteSkills}
            onChange={setOverwriteSkills}
          />
        </Stack>
      </Modal>
    </Card>
  );
}
