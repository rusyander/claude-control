import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderInstructionsEntry } from '@claude-control/contracts';
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
  useProviderInstructions,
  useSaveProviderInstructions,
} from '@entities/ProviderInstructions';
import { useWritePreview } from '@features/WritePreview';
import { ProviderInstructionsFileEditor } from './ProviderInstructionsFileEditor';
import type { ProviderInstructionsPanelProps } from './ProviderInstructionsPanel.types';

/**
 * Инструкции в модели СПИСКА ССЫЛОК (AIDER-1) — общая начинка для глобального
 * раздела и для вкладки проекта (AIDER-4): отличается только `projectId`.
 *
 * ЧЕСТНО О МОДЕЛИ. Это НЕ редактор файла вроде CLAUDE.md/AGENTS.md. У Aider
 * единого файла инструкций нет: файлы контекста перечисляются опцией `read` в
 * `.aider.conf.yml`. Панель правит ИМЕННО ЭТОТ СПИСОК — добавить ссылку, убрать,
 * переставить (порядок = порядок подключения). Содержимое перечисленного файла
 * можно открыть и поправить отдельно — но только если файл уже существует:
 * файлов «от себя» панель не создаёт.
 */
export function ProviderInstructionsPanel({ projectId }: ProviderInstructionsPanelProps) {
  const { t } = useTranslation();
  const scope = projectId ? { projectId } : {};
  const { data, isLoading } = useProviderInstructions(scope);
  const save = useSaveProviderInstructions(scope);
  const { ask, dialog } = useWritePreview();

  const [draft, setDraft] = useState('');
  const [openEntry, setOpenEntry] = useState<string | undefined>(undefined);

  if (isLoading || !data) return <SkeletonList rows={5} />;

  const entries = data.entries;
  const readOnly = data.readOnly;
  const rawList = entries.map((entry) => entry.raw);

  // Предпросмотр считается по ГЛОБАЛЬНОЙ конфигурации провайдера, поэтому в
  // проектной вкладке он не предлагается: показывать дифф чужого файла вместо
  // правимого — хуже, чем не показывать ничего.
  const commit = (next: string[]): void => {
    if (projectId) {
      save.mutate(next);
      return;
    }
    ask({ section: 'instructions', draft: { entries: next } }, () => save.mutate(next));
  };

  const add = (): void => {
    const value = draft.trim();
    if (!value || rawList.includes(value)) return;
    commit([...rawList, value]);
    setDraft('');
  };

  const remove = (entry: ProviderInstructionsEntry): void => {
    commit(rawList.filter((raw) => raw !== entry.raw));
    if (openEntry === entry.raw) setOpenEntry(undefined);
  };

  // Перестановка — это просто другой порядок массива: сервер пишет список как есть.
  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= rawList.length) return;
    const next = [...rawList];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    commit(next);
  };

  const duplicate = Boolean(draft.trim()) && rawList.includes(draft.trim());

  return (
    <Stack gap="var(--spacing-md)">
      <ExplainBox
        title={t('providerInstructions.explainTitle')}
        text={t('providerInstructions.explain', {
          provider: data.providerName,
          fileName: data.configPath,
        })}
      />

      <Card padding="sm">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Icon name="file" size={18} />
          <Typography variant="body-sm" color="muted">
            {t('providerInstructions.configPath')}
          </Typography>
          <Typography variant="mono" color="subtle" as="span" truncate>
            {data.configPath}
          </Typography>
          {!data.configExists && (
            <Badge tone="neutral">{t('providerInstructions.configMissing')}</Badge>
          )}
        </Stack>
      </Card>

      {readOnly && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="warning" size={18} />
            <Typography variant="body-sm" color="warning">
              {t('providerInstructions.readOnly', { path: data.configPath })}
            </Typography>
          </Stack>
        </Card>
      )}

      <Card padding="none">
        <Stack>
          {entries.map((entry, index) => (
            <Stack key={entry.raw} gap="var(--spacing-2xs)" padding="var(--spacing-sm)">
              <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
                <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
                  <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
                    <Typography variant="mono" weight="medium" as="span">
                      {entry.raw}
                    </Typography>
                    <Badge tone={entry.exists ? 'success' : 'warning'}>
                      {entry.exists
                        ? t('providerInstructions.exists')
                        : t('providerInstructions.missing')}
                    </Badge>
                  </Stack>
                  <Typography variant="mono" color="subtle" as="span" truncate>
                    {entry.path}
                  </Typography>
                  {!entry.editable && entry.reason && entry.reason !== 'missing' && (
                    <Typography variant="caption" color="subtle">
                      {t(`providerInstructions.reason_${entry.reason}`)}
                    </Typography>
                  )}
                </Stack>

                <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Icon name="chevronUp" size={24} />}
                    aria-label={`${t('providerInstructions.moveUp')}: ${entry.raw}`}
                    disabled={readOnly || index === 0 || save.isPending}
                    onClick={() => move(index, -1)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Icon name="chevronDown" size={24} />}
                    aria-label={`${t('providerInstructions.moveDown')}: ${entry.raw}`}
                    disabled={readOnly || index === entries.length - 1 || save.isPending}
                    onClick={() => move(index, 1)}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!entry.editable}
                    onClick={() => setOpenEntry(openEntry === entry.raw ? undefined : entry.raw)}
                  >
                    {openEntry === entry.raw
                      ? t('providerInstructions.closeFile')
                      : t('providerInstructions.editFile')}
                  </Button>
                  {!readOnly && (
                    <DeleteButton
                      entityName={entry.raw}
                      description={t('providerInstructions.removeEntry')}
                      onDelete={() => remove(entry)}
                      isPending={save.isPending}
                    />
                  )}
                </Stack>
              </Stack>

              {openEntry === entry.raw && entry.editable && (
                <ProviderInstructionsFileEditor raw={entry.raw} projectId={projectId} />
              )}
            </Stack>
          ))}
        </Stack>
      </Card>

      {entries.length === 0 && (
        <Typography color="subtle">{t('providerInstructions.empty')}</Typography>
      )}

      {!readOnly && (
        <Card padding="md">
          <Stack gap="var(--spacing-sm)">
            <TextField
              label={t('providerInstructions.addLabel')}
              value={draft}
              onChange={setDraft}
              placeholder="CONVENTIONS.md"
              isMono
              hint={t('providerInstructions.addHint', { baseDir: data.baseDir })}
              error={duplicate ? t('providerInstructions.duplicate') : undefined}
            />
            <Stack direction="row" justify="end">
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Icon name="plus" size={18} />}
                disabled={!draft.trim() || duplicate}
                isLoading={save.isPending}
                onClick={add}
              >
                {t('providerInstructions.addEntry')}
              </Button>
            </Stack>
          </Stack>
        </Card>
      )}

      <Typography variant="caption" color="subtle">
        {t('providers.needsRestartFor', { provider: data.providerName })}
      </Typography>

      {dialog}
    </Stack>
  );
}
