import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderEnvVar } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { SkeletonList } from '@shared/ui/skeleton';
import { DeleteButton } from '@features/EntityDelete';
import { useProviderEnv, useSaveProviderEnv } from '@entities/ProviderEnv';
import { useWritePreview } from '@features/WritePreview';
import { ProviderEnvForm } from './ProviderEnvForm';

/**
 * Универсальный раздел переменных окружения активного провайдера (Codex — TOML,
 * Aider — YAML, Gemini — `.env`). Базовый CRUD по KV: список, добавить, править,
 * удалить. Запись — bulk: любое изменение пересобирает полный набор и отправляет
 * одним PUT (сервер правит только «свой» участок файла, прочее сохраняет). Если
 * формат файла не распознан — раздел только для чтения. Раздел Claude —
 * отдельная богатая страница, сюда не попадает.
 */
export function ProviderEnvPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useProviderEnv();
  const save = useSaveProviderEnv();
  const { ask, dialog } = useWritePreview();

  // Запись в чужой .env/TOML/YAML идёт через предпросмотр: показываем дифф и
  // пишем только после подтверждения (для Claude и при выключенной настройке
  // обёртка вызывает запись сразу).
  const saveWithPreview = (next: ProviderEnvVar[], onDone?: () => void): void => {
    ask({ section: 'env', draft: { vars: next } }, () =>
      save.mutate(next, onDone ? { onSuccess: onDone } : undefined),
    );
  };

  const [editing, setEditing] = useState<ProviderEnvVar | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);

  if (isLoading || !data) {
    return <SkeletonList rows={5} />;
  }

  const vars = data.vars;
  const readOnly = data.readOnly;

  const openCreate = (): void => {
    setEditing(undefined);
    setIsFormOpen(true);
  };
  const openEdit = (item: ProviderEnvVar): void => {
    setEditing(item);
    setIsFormOpen(true);
  };

  // Любое изменение пересобирает полный набор пар и отправляет одним PUT.
  const submit = (draft: ProviderEnvVar): void => {
    const next = editing
      ? vars.map((item) => (item.key === editing.key ? draft : item))
      : [...vars, draft];
    saveWithPreview(next, () => setIsFormOpen(false));
  };

  const remove = (item: ProviderEnvVar): void => {
    saveWithPreview(vars.filter((v) => v.key !== item.key));
  };

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader
        title={t('providerEnv.title', { provider: data.providerName })}
        subtitle={t('providerEnv.subtitle', { provider: data.providerName })}
        helpTopic="env"
        actions={
          !readOnly && (
            <Button
              variant="primary"
              leftIcon={<Icon name="plus" size={24} />}
              onClick={openCreate}
            >
              {t('providerEnv.addVar')}
            </Button>
          )
        }
      />

      <ExplainBox
        title={t('providerEnv.explainTitle')}
        // Пояснение зависит от формата файла: таблица TOML у Codex, ключ set-env
        // у Aider, обычный .env у Gemini — правила правки у них разные.
        text={t(`providerEnv.explain_${data.format}`, {
          provider: data.providerName,
          fileName: data.filePath,
        })}
      />

      {!data.cliDetected && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="info" size={18} />
            <Typography variant="body-sm" color="muted">
              {t('providerEnv.cliMissing', { provider: data.providerName, path: data.filePath })}
            </Typography>
          </Stack>
        </Card>
      )}

      {readOnly && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="warning" size={18} />
            <Typography variant="body-sm" color="warning">
              {t('providerEnv.readOnly', { path: data.filePath })}
            </Typography>
          </Stack>
        </Card>
      )}

      <Card padding="none">
        <Stack>
          {vars.map((item) => (
            <Stack
              key={item.key}
              direction="row"
              align="center"
              justify="between"
              gap="var(--spacing-sm)"
              padding="var(--spacing-sm)"
            >
              <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
                <Typography variant="mono" weight="medium" as="span">
                  {item.key}
                </Typography>
                <Typography variant="mono" color="subtle" as="span" truncate>
                  {item.value}
                </Typography>
              </Stack>

              {!readOnly && (
                <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Icon name="edit" size={24} />}
                    aria-label={`${t('common.edit')}: ${item.key}`}
                    onClick={() => openEdit(item)}
                  />
                  <DeleteButton
                    entityName={item.key}
                    description={t('providerEnv.deleteVar')}
                    onDelete={() => remove(item)}
                    isPending={save.isPending}
                  />
                </Stack>
              )}
            </Stack>
          ))}
        </Stack>
      </Card>

      {vars.length === 0 && <Typography color="subtle">{t('common.empty')}</Typography>}

      <ProviderEnvForm
        isOpen={isFormOpen}
        providerName={data.providerName}
        onOpenChange={setIsFormOpen}
        envVar={editing}
        existingKeys={vars.map((v) => v.key)}
        onSubmit={submit}
        isPending={save.isPending}
      />

      {dialog}
    </Stack>
  );
}
