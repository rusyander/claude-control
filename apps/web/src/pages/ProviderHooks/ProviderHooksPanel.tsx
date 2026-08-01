import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderHookPatternGroup, ProviderHookAction } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { ExplainBox } from '@shared/ui/explain-box';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProviderHooks, useSaveProviderHooks } from '@entities/ProviderHooks';
import { ProviderHookActionEditor } from './ProviderHookActionEditor';
import { ProviderHookRulesEditor } from './ProviderHookRulesEditor';
import {
  emptyActionRow,
  nextRowId,
  stableDraft,
  toActionDraft,
  toActionRow,
  toPatternDraft,
  toPatternRow,
} from './ProviderHooks.lib';
import type { ActionRow, HooksFormState, PatternRow } from './ProviderHooks.types';
import type { ProviderHooksPanelProps } from './ProviderHooksPanel.types';

/**
 * Хуки НЕ-Claude провайдера — общая начинка для глобального раздела и для
 * вкладки проекта: отличается только `projectId`.
 *
 * ФОРМ ДВЕ, и выбирает их сервер полем `shape`: плоский список правил
 * «событие → команда» (Qwen, Kimi — `ProviderHookRulesEditor`) либо два события
 * OpenCode с действиями-argv (ниже в этом файле).
 *
 * ЧЕСТНО О МОДЕЛИ. Это НЕ хуки Claude. У OpenCode хуки живут ключом
 * `experimental.hook` в `opencode.json`, событий ровно два (`file_edited` и
 * `session_completed`), а команда задаётся СПИСКОМ АРГУМЕНТОВ, а не строкой для
 * оболочки. И главное: ключ лежит под `experimental` — сам OpenCode называет
 * такие настройки нестабильными, и панель говорит это прямо, а не выдаёт раздел
 * за устоявшийся API.
 *
 * Всё, чего панель не понимает (чужое событие внутри `hook`, прочие ключи
 * `experimental`), показано отдельной карточкой ТОЛЬКО ДЛЯ ЧТЕНИЯ и остаётся в
 * файле нетронутым.
 */
export function ProviderHooksPanel({ projectId }: ProviderHooksPanelProps) {
  const { t } = useTranslation();
  const scope = projectId ? { projectId } : {};
  const { data, isLoading } = useProviderHooks(scope);
  const save = useSaveProviderHooks(scope);

  const [state, setState] = useState<HooksFormState>({ fileEdited: [], sessionCompleted: [] });

  useEffect(() => {
    if (!data) return;
    setState({
      fileEdited: data.fileEdited.map(toPatternRow),
      sessionCompleted: data.sessionCompleted.map(toActionRow),
    });
  }, [data]);

  if (isLoading || !data) return <SkeletonList rows={5} />;

  // Другая модель — другой редактор. Ветка стоит ПОСЛЕ хуков React намеренно:
  // состояние выше нужно объявить безусловно, а рисуем мы уже по данным.
  if (data.shape === 'event-rules') {
    return <ProviderHookRulesEditor data={data} projectId={projectId} />;
  }

  const readOnly = data.readOnly;
  // Событие, форму которого панель не разобрала, редактировать нельзя вовсе:
  // сервер такой черновик отвергнет (422), и правильно сделает.
  const lockedFileEdited = data.preservedEvents.some((entry) => entry.key === 'file_edited');
  const lockedSession = data.preservedEvents.some((entry) => entry.key === 'session_completed');

  const fileEdited = state.fileEdited
    .map(toPatternDraft)
    .filter((group): group is ProviderHookPatternGroup => Boolean(group));
  const sessionCompleted = state.sessionCompleted
    .map(toActionDraft)
    .filter((action): action is ProviderHookAction => Boolean(action));

  const dirty =
    stableDraft(fileEdited) !== stableDraft(data.fileEdited) ||
    stableDraft(sessionCompleted) !== stableDraft(data.sessionCompleted);

  const submit = (): void => save.mutate({ fileEdited, sessionCompleted });

  const patchPattern = (id: number, patch: Partial<PatternRow>): void =>
    setState((prev) => ({
      ...prev,
      fileEdited: prev.fileEdited.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));

  const patchSessionAction = (id: number, patch: Partial<ActionRow>): void =>
    setState((prev) => ({
      ...prev,
      sessionCompleted: prev.sessionCompleted.map((row) =>
        row.id === id ? { ...row, ...patch } : row,
      ),
    }));

  return (
    <Stack gap="var(--spacing-md)">
      <ExplainBox
        title={t('providerHooks.explainTitle')}
        text={t('providerHooks.explain', {
          provider: data.providerName,
          filePath: data.filePath,
        })}
      />

      <Card padding="sm">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Icon name="warning" size={18} />
          <Typography variant="body-sm" color="warning">
            {t('providerHooks.experimentalNote', { provider: data.providerName })}
          </Typography>
        </Stack>
      </Card>

      <Card padding="sm">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Icon name="file" size={18} />
          <Typography variant="body-sm" color="muted">
            {t('providerHooks.filePath')}
          </Typography>
          <Typography variant="mono" color="subtle" as="span" truncate>
            {data.filePath}
          </Typography>
          {!data.present && <Badge tone="neutral">{t('providerHooks.absent')}</Badge>}
        </Stack>
      </Card>

      {/* Ключ снят с записи самим CLI (у OpenCode `experimental.hook` исчез из
          документации и схемы). Это НЕ поломка файла: показываем причину и куда
          идти вместо этого, а не общее «только для чтения». */}
      {data.writeDisabledReason ? (
        <Card padding="sm">
          <Stack gap="var(--spacing-2xs)">
            <Stack direction="row" align="center" gap="var(--spacing-xs)">
              <Icon name="warning" size={18} />
              <Typography variant="body-sm" color="warning">
                {data.writeDisabledReason}
              </Typography>
            </Stack>
            <Typography variant="body-sm" color="subtle">
              {t('providerHooks.writeDisabledHint')}
            </Typography>
          </Stack>
        </Card>
      ) : (
        readOnly && (
          <Card padding="sm">
            <Stack direction="row" align="center" gap="var(--spacing-xs)">
              <Icon name="warning" size={18} />
              <Typography variant="body-sm" color="warning">
                {t('providerHooks.readOnly', { path: data.filePath })}
              </Typography>
            </Stack>
          </Card>
        )
      )}

      {/* --- Событие file_edited: карта «шаблон файлов → действия» --- */}
      <Card padding="md">
        <Stack gap="var(--spacing-md)">
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="heading-sm" as="h3">
              {t('providerHooks.fileEdited.title')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('providerHooks.fileEdited.hint')}
            </Typography>
          </Stack>

          {lockedFileEdited && (
            <Typography variant="body-sm" color="warning">
              {t('providerHooks.eventLocked')}
            </Typography>
          )}

          {state.fileEdited.map((group) => (
            <Card key={group.id} padding="sm">
              <Stack gap="var(--spacing-sm)">
                <Stack direction="row" align="end" gap="var(--spacing-xs)" wrap>
                  <Stack flex={1} minWidth={0}>
                    <TextField
                      label={t('providerHooks.fileEdited.pattern')}
                      value={group.pattern}
                      onChange={(value) => patchPattern(group.id, { pattern: value })}
                      placeholder="*.ts"
                      isMono
                      disabled={readOnly || lockedFileEdited}
                    />
                  </Stack>
                  {!readOnly && !lockedFileEdited && (
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={<Icon name="trash" size={24} />}
                      aria-label={`${t('common.delete')}: ${group.pattern}`}
                      onClick={() =>
                        setState((prev) => ({
                          ...prev,
                          fileEdited: prev.fileEdited.filter((row) => row.id !== group.id),
                        }))
                      }
                    />
                  )}
                </Stack>

                {group.actions.map((action) => (
                  <ProviderHookActionEditor
                    key={action.id}
                    action={action}
                    disabled={readOnly || lockedFileEdited}
                    onChange={(patch) =>
                      patchPattern(group.id, {
                        actions: group.actions.map((row) =>
                          row.id === action.id ? { ...row, ...patch } : row,
                        ),
                      })
                    }
                    onRemove={() =>
                      patchPattern(group.id, {
                        actions: group.actions.filter((row) => row.id !== action.id),
                      })
                    }
                  />
                ))}

                {!readOnly && !lockedFileEdited && (
                  <Stack direction="row">
                    <Button
                      size="sm"
                      variant="secondary"
                      leftIcon={<Icon name="plus" size={20} />}
                      onClick={() =>
                        patchPattern(group.id, { actions: [...group.actions, emptyActionRow()] })
                      }
                    >
                      {t('providerHooks.fileEdited.addAction')}
                    </Button>
                  </Stack>
                )}
              </Stack>
            </Card>
          ))}

          {state.fileEdited.length === 0 && (
            <Typography color="subtle">{t('providerHooks.fileEdited.empty')}</Typography>
          )}

          {!readOnly && !lockedFileEdited && (
            <Stack direction="row">
              <Button
                variant="secondary"
                leftIcon={<Icon name="plus" size={20} />}
                onClick={() =>
                  setState((prev) => ({
                    ...prev,
                    fileEdited: [
                      ...prev.fileEdited,
                      { id: nextRowId(), pattern: '', actions: [emptyActionRow()] },
                    ],
                  }))
                }
              >
                {t('providerHooks.fileEdited.addPattern')}
              </Button>
            </Stack>
          )}
        </Stack>
      </Card>

      {/* --- Событие session_completed: просто список действий --- */}
      <Card padding="md">
        <Stack gap="var(--spacing-md)">
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="heading-sm" as="h3">
              {t('providerHooks.sessionCompleted.title')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('providerHooks.sessionCompleted.hint')}
            </Typography>
          </Stack>

          {lockedSession && (
            <Typography variant="body-sm" color="warning">
              {t('providerHooks.eventLocked')}
            </Typography>
          )}

          {state.sessionCompleted.map((action) => (
            <ProviderHookActionEditor
              key={action.id}
              action={action}
              disabled={readOnly || lockedSession}
              onChange={(patch) => patchSessionAction(action.id, patch)}
              onRemove={() =>
                setState((prev) => ({
                  ...prev,
                  sessionCompleted: prev.sessionCompleted.filter((row) => row.id !== action.id),
                }))
              }
            />
          ))}

          {state.sessionCompleted.length === 0 && (
            <Typography color="subtle">{t('providerHooks.sessionCompleted.empty')}</Typography>
          )}

          {!readOnly && !lockedSession && (
            <Stack direction="row">
              <Button
                variant="secondary"
                leftIcon={<Icon name="plus" size={20} />}
                onClick={() =>
                  setState((prev) => ({
                    ...prev,
                    sessionCompleted: [...prev.sessionCompleted, emptyActionRow()],
                  }))
                }
              >
                {t('providerHooks.sessionCompleted.addAction')}
              </Button>
            </Stack>
          )}
        </Stack>
      </Card>

      {(data.preservedEvents.length > 0 || data.preservedExperimental.length > 0) && (
        <Card padding="md">
          <Stack gap="var(--spacing-xs)">
            <Typography variant="body" weight="medium">
              {t('providerHooks.preserved.title')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('providerHooks.preserved.text')}
            </Typography>
            <Stack gap="var(--spacing-3xs)">
              {data.preservedEvents.map((item) => (
                <Typography key={`hook-${item.key}`} variant="mono" color="subtle" as="span">
                  hook.{item.key}: {item.value}
                </Typography>
              ))}
              {data.preservedExperimental.map((item) => (
                <Typography key={`exp-${item.key}`} variant="mono" color="subtle" as="span">
                  experimental.{item.key}: {item.value}
                </Typography>
              ))}
            </Stack>
          </Stack>
        </Card>
      )}

      {!readOnly && (
        <Stack direction="row" gap="var(--spacing-xs)">
          <Button onClick={submit} disabled={!dirty || save.isPending}>
            {t('common.save')}
          </Button>
        </Stack>
      )}

      <Typography variant="caption" color="subtle">
        {t('common.needsRestart')}
      </Typography>
    </Stack>
  );
}
