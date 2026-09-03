import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { ExplainBox } from '@shared/ui/explain-box';
import { SkeletonList } from '@shared/ui/skeleton';
import { DeleteButton } from '@features/EntityDelete';
import {
  useProviderPlugins,
  useDeleteProviderPluginFile,
  useSaveProviderPluginFile,
  useSaveProviderPluginPackages,
} from '@entities/ProviderPlugins';
import { ProviderPluginFileEditor } from './ProviderPluginFileEditor';
import { ProviderInstalledPlugins } from './ProviderInstalledPlugins';
import { fileError, packageError } from './ProviderPluginsPanel.lib';
import type { ProviderPluginsPanelProps } from './ProviderPluginsPanel.types';

/**
 * Плагины CLI (OPENCODE-4) — общая начинка для глобального раздела и вкладки
 * проекта: отличается только `projectId`.
 *
 * ЧЕСТНО О МОДЕЛИ. Это НЕ раздел «Плагины» самой панели. Здесь плагины чужого
 * CLI, и подключаются они двумя задокументированными способами сразу:
 *
 *  1. ФАЙЛЫ в каталоге плагинов (JS/TS), которые CLI грузит при старте;
 *  2. NPM-ПАКЕТЫ, перечисленные в конфиге ключом `plugin`.
 *
 * Половины независимы: сломанный конфиг не мешает править файлы, и наоборот.
 * Записи расширенной формы (`[имя, {настройки}]`) панель не ведёт — они
 * показаны только для чтения и остаются в файле нетронутыми.
 */
export function ProviderPluginsPanel({ projectId }: ProviderPluginsPanelProps) {
  const { t } = useTranslation();
  const scope = projectId ? { projectId } : {};
  const { data, isLoading } = useProviderPlugins(scope);
  const saveFile = useSaveProviderPluginFile(scope);
  const removeFile = useDeleteProviderPluginFile(scope);
  const savePackages = useSaveProviderPluginPackages(scope);

  const [openFile, setOpenFile] = useState<string | undefined>(undefined);
  const [newFile, setNewFile] = useState('');
  const [packages, setPackages] = useState<string[]>([]);
  const [newPackage, setNewPackage] = useState('');

  useEffect(() => {
    if (data) setPackages(data.packages);
  }, [data]);

  if (isLoading || !data) return <SkeletonList rows={5} />;

  // У Kimi половина одна и она только для чтения: список установленного.
  // Ветка стоит ПОСЛЕ хуков React намеренно — состояние объявляется безусловно.
  if (data.sections.includes('installed')) return <ProviderInstalledPlugins data={data} />;

  // --- файлы ---
  const trimmedName = newFile.trim().replace(/^[/\\]+/, '');
  const fileName =
    trimmedName && !/\.(js|ts|mjs)$/i.test(trimmedName) ? `${trimmedName}.ts` : trimmedName;
  const duplicateFile = Boolean(fileName) && data.files.some((file) => file.path === fileName);
  const unsafeFile =
    /(^|[/\\])\.\.([/\\]|$)/.test(trimmedName) || /^([/\\]|[A-Za-z]:)/.test(trimmedName);

  const createFile = (): void => {
    if (!fileName || duplicateFile || unsafeFile) return;
    saveFile.mutate(
      { path: fileName, content: '' },
      {
        onSuccess: () => {
          setOpenFile(fileName);
          setNewFile('');
        },
      },
    );
  };

  // --- npm-пакеты ---
  const packagesDirty = JSON.stringify(packages) !== JSON.stringify(data.packages);
  const trimmedPackage = newPackage.trim();
  const duplicatePackage = Boolean(trimmedPackage) && packages.includes(trimmedPackage);
  // Пробел или кавычка в имени — сервер такое отклонит, скажем заранее.
  const invalidPackage = Boolean(trimmedPackage) && !/^[^\s"']+$/.test(trimmedPackage);

  return (
    <Stack gap="var(--spacing-md)">
      <ExplainBox
        title={t('providerPlugins.explainTitle')}
        text={t('providerPlugins.explain', {
          provider: data.providerName,
          pluginsDir: data.pluginsDir,
          configPath: data.configPath,
        })}
      />

      {/* --- половина 1: файлы каталога --- */}
      <Card padding="sm">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Icon name="folder" size={18} />
          <Typography variant="body-sm" color="muted">
            {t('providerPlugins.pluginsDir')}
          </Typography>
          <Typography variant="mono" color="subtle" as="span" truncate>
            {data.pluginsDir}
          </Typography>
          {!data.dirExists && <Badge tone="neutral">{t('providerPlugins.dirMissing')}</Badge>}
        </Stack>
      </Card>

      {data.filesReadOnly && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="warning" size={18} />
            <Typography variant="body-sm" color="warning">
              {t('providerPlugins.dirUnreadable', { path: data.pluginsDir })}
            </Typography>
          </Stack>
        </Card>
      )}

      {data.files.length > 0 && (
        <Card padding="none">
          <Stack>
            {data.files.map((file) => (
              <Stack key={file.path} gap="var(--spacing-2xs)" padding="var(--spacing-sm)">
                <Stack
                  direction="row"
                  align="center"
                  justify="between"
                  gap="var(--spacing-sm)"
                  wrap
                >
                  <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
                    <Typography variant="mono" weight="medium" as="span">
                      {file.path}
                    </Typography>
                    <Typography variant="mono" color="subtle" as="span" truncate>
                      {file.fullPath}
                    </Typography>
                  </Stack>

                  <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setOpenFile(openFile === file.path ? undefined : file.path)}
                    >
                      {openFile === file.path ? t('common.close') : t('providerPlugins.file.edit')}
                    </Button>
                    <DeleteButton
                      entityName={file.path}
                      description={t('providerPlugins.file.delete')}
                      onDelete={() => {
                        removeFile.mutate(file.path);
                        if (openFile === file.path) setOpenFile(undefined);
                      }}
                      isPending={removeFile.isPending}
                    />
                  </Stack>
                </Stack>

                {openFile === file.path && (
                  <ProviderPluginFileEditor
                    path={file.path}
                    projectId={projectId}
                    onClose={() => setOpenFile(undefined)}
                  />
                )}
              </Stack>
            ))}
          </Stack>
        </Card>
      )}

      {data.files.length === 0 && !data.filesReadOnly && (
        <Typography color="subtle">{t('providerPlugins.file.empty')}</Typography>
      )}

      {data.ignored.length > 0 && (
        <Card padding="sm">
          <Stack gap="var(--spacing-2xs)">
            <Stack direction="row" align="center" gap="var(--spacing-xs)">
              <Icon name="info" size={18} />
              <Typography variant="body-sm" color="muted">
                {t('providerPlugins.ignoredTitle')}
              </Typography>
            </Stack>
            <Typography variant="caption" color="subtle">
              {t('providerPlugins.ignoredExplain')}
            </Typography>
            {data.ignored.map((file) => (
              <Typography key={file.path} variant="mono" color="subtle" as="span" truncate>
                {file.path}
              </Typography>
            ))}
          </Stack>
        </Card>
      )}

      {!data.filesReadOnly && (
        <Card padding="md">
          <Stack gap="var(--spacing-sm)">
            <Typography variant="heading-sm" as="h3">
              {t('providerPlugins.file.createTitle')}
            </Typography>
            <TextField
              label={t('providerPlugins.file.fieldPath')}
              value={newFile}
              onChange={setNewFile}
              placeholder="notify.ts"
              isMono
              hint={t('providerPlugins.file.hintPath', { pluginsDir: data.pluginsDir })}
              error={fileError(duplicateFile, unsafeFile, t)}
            />
            <Stack direction="row" justify="end">
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Icon name="plus" size={18} />}
                disabled={!fileName || duplicateFile || unsafeFile}
                isLoading={saveFile.isPending}
                onClick={createFile}
              >
                {t('providerPlugins.file.create')}
              </Button>
            </Stack>
          </Stack>
        </Card>
      )}

      {/* --- половина 2: npm-пакеты в конфиге --- */}
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="heading-sm" as="h3">
              {t('providerPlugins.packages.title')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('providerPlugins.packages.hint')}
            </Typography>
            <Typography variant="mono" color="subtle" as="span" truncate>
              {data.configPath}
            </Typography>
          </Stack>

          {data.packagesReadOnly && (
            <Stack direction="row" align="center" gap="var(--spacing-xs)">
              <Icon name="warning" size={18} />
              <Typography variant="body-sm" color="warning">
                {t('providerPlugins.packages.readOnly', { path: data.configPath })}
              </Typography>
            </Stack>
          )}

          {packages.map((name, index) => (
            <Stack key={`${name}-${index}`} direction="row" align="center" gap="var(--spacing-xs)">
              <Typography variant="mono" as="span" truncate>
                {name}
              </Typography>
              {!data.packagesReadOnly && (
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="trash" size={24} />}
                  aria-label={`${t('common.delete')}: ${name}`}
                  onClick={() => setPackages(packages.filter((item) => item !== name))}
                />
              )}
            </Stack>
          ))}

          {packages.length === 0 && (
            <Typography color="subtle">{t('providerPlugins.packages.empty')}</Typography>
          )}

          {!data.packagesReadOnly && (
            <>
              <Stack direction="row" align="end" gap="var(--spacing-xs)" wrap>
                <Stack flex={1} minWidth={0}>
                  <TextField
                    label={t('providerPlugins.packages.field')}
                    value={newPackage}
                    onChange={setNewPackage}
                    placeholder="@my-org/custom-plugin"
                    isMono
                    error={packageError(duplicatePackage, invalidPackage, t)}
                  />
                </Stack>
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<Icon name="plus" size={20} />}
                  disabled={!trimmedPackage || duplicatePackage || invalidPackage}
                  onClick={() => {
                    setPackages([...packages, trimmedPackage]);
                    setNewPackage('');
                  }}
                >
                  {t('providerPlugins.packages.add')}
                </Button>
              </Stack>

              <Stack direction="row" justify="end">
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<Icon name="check" size={18} />}
                  disabled={!packagesDirty}
                  isLoading={savePackages.isPending}
                  onClick={() => savePackages.mutate(packages)}
                >
                  {t('common.save')}
                </Button>
              </Stack>
            </>
          )}

          {data.preservedPackages.length > 0 && (
            <Stack gap="var(--spacing-3xs)">
              <Typography variant="body-sm" weight="medium">
                {t('providerPlugins.packages.preservedTitle')}
              </Typography>
              <Typography variant="caption" color="subtle">
                {t('providerPlugins.packages.preservedText')}
              </Typography>
              {data.preservedPackages.map((item) => (
                <Typography key={item.index} variant="mono" color="subtle" as="span">
                  [{item.index}]: {item.value}
                </Typography>
              ))}
            </Stack>
          )}
        </Stack>
      </Card>

      <Typography variant="caption" color="subtle">
        {t('providers.needsRestartFor', { provider: data.providerName })}
      </Typography>
    </Stack>
  );
}
