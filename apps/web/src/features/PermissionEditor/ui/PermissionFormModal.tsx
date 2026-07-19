import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PERMISSION_PRESETS,
  type PermissionDecision,
  type PermissionPreset,
} from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { FormWithAssistant } from '@shared/ui/form-with-assistant';
import { permissionApi } from '@entities/Permission';
import { BulkCreate } from '@features/BulkCreate';
import type { PermissionFormModalProps } from './PermissionFormModal.types';
import styles from './PermissionFormModal.module.scss';

const DECISIONS: PermissionDecision[] = ['allow', 'ask', 'deny'];

const RISK_TONE = { low: 'success', medium: 'warning', high: 'danger' } as const;

/**
 * Создание и правка правила доступа. Правила пишутся в особом формате
 * `Инструмент(аргумент:шаблон)`, поэтому рядом список готовых заготовок —
 * выбрать из списка надёжнее, чем вспоминать синтаксис.
 */
export function PermissionFormModal({
  isOpen,
  onOpenChange,
  rule,
  initialPattern,
}: PermissionFormModalProps) {
  const { t } = useTranslation();
  const [pattern, setPattern] = useState('');
  const [decision, setDecision] = useState<PermissionDecision>('ask');
  const [category, setCategory] = useState<PermissionPreset['category']>('filesystem');
  // Одно правило или список сразу. Пакетный режим — только при создании:
  // редактируют всегда одну запись.
  const [isBulk, setIsBulk] = useState(false);

  const create = permissionApi.useCreate();
  const update = permissionApi.useUpdate();

  useEffect(() => {
    if (!isOpen) return;
    setPattern(rule?.pattern ?? initialPattern ?? '');
    setDecision(rule?.decision ?? 'ask');
    setIsBulk(false);
  }, [isOpen, rule, initialPattern]);

  const isPending = create.isPending || update.isPending;
  const canSave = pattern.trim().length > 0 && !isPending;

  const categories = [...new Set(PERMISSION_PRESETS.map((preset) => preset.category))];
  const visiblePresets = PERMISSION_PRESETS.filter((preset) => preset.category === category);

  const handleSave = (): void => {
    const draft = { pattern: pattern.trim(), decision, groupIds: [] };
    const onDone = { onSuccess: () => onOpenChange(false) };

    if (rule) update.mutate({ id: rule.id, draft }, onDone);
    else create.mutate(draft, onDone);
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={rule ? t('common.edit') : t('permissions.addRule')}
      description={t('common.needsRestart')}
      size="xl"
      footer={
        // В пакетном режиме своя кнопка создания внутри — общий «Сохранить»
        // тут был бы лишним.
        isBulk ? (
          <Button onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={!canSave}
              isLoading={isPending}
            >
              {t('common.save')}
            </Button>
          </>
        )
      }
    >
      {!rule && (
        <div className={styles.modeTabs}>
          <Button
            size="sm"
            variant={!isBulk ? 'primary' : 'ghost'}
            onClick={() => setIsBulk(false)}
          >
            {t('bulk.modeSingle')}
          </Button>
          <Button size="sm" variant={isBulk ? 'primary' : 'ghost'} onClick={() => setIsBulk(true)}>
            {t('bulk.modeMany')}
          </Button>
        </div>
      )}

      {isBulk ? (
        <BulkCreate
          kindLabel={t('permissions.title')}
          placeholder={'Bash(git push:*)\nRead\nWebFetch\nmcp__gitlab__create_merge_request'}
          controls={
            <Stack gap="var(--spacing-2xs)">
              <Typography variant="body-sm" weight="medium" as="span">
                {t('permissions.decision')}
              </Typography>
              <Stack direction="row" gap="var(--spacing-2xs)" wrap>
                {DECISIONS.map((item) => (
                  <Button
                    key={item}
                    size="sm"
                    variant={decision === item ? 'primary' : 'secondary'}
                    onClick={() => setDecision(item)}
                  >
                    {t(`permissions.${item}`)}
                  </Button>
                ))}
              </Stack>
              <Typography variant="caption" color="subtle">
                {t('bulk.sharedDecision')}
              </Typography>
            </Stack>
          }
          parseLine={(line) => {
            // Правило доступа — это имя инструмента, возможно с уточнением.
            // Проверяем только, что скобки парные: остальное решает Claude Code.
            const open = (line.match(/\(/g) ?? []).length;
            const close = (line.match(/\)/g) ?? []).length;
            if (open !== close) return { raw: line, error: t('bulk.unbalanced') };
            return { raw: line, draft: { pattern: line, decision, groupIds: [] } };
          }}
          createOne={(draft) => create.mutateAsync(draft)}
          renderPreview={(draft) => (
            <Stack direction="row" align="center" gap="var(--spacing-xs)">
              <Badge tone={draft.decision === 'deny' ? 'danger' : 'neutral'}>
                {t(`permissions.${draft.decision}`)}
              </Badge>
              <Typography variant="mono" as="span">
                {draft.pattern}
              </Typography>
            </Stack>
          )}
          onDone={() => onOpenChange(false)}
        />
      ) : (
        <FormWithAssistant
          kind={t('permissions.title')}
          fields={{ pattern, decision }}
          schema={{
            pattern:
              'Правило доступа: имя инструмента целиком (Bash, Read, WebFetch) или с уточнением — Bash(git push:*), mcp__сервер__инструмент',
            decision: 'Решение: allow (делать без вопросов), ask (спрашивать), deny (запретить)',
          }}
          onApply={(applied) => {
            if (typeof applied.pattern === 'string') setPattern(applied.pattern);
            if (
              typeof applied.decision === 'string' &&
              DECISIONS.includes(applied.decision as PermissionDecision)
            ) {
              setDecision(applied.decision as PermissionDecision);
            }
          }}
        >
          <Stack gap="var(--spacing-md)">
            {!rule && (
              <Card padding="md">
                <Stack gap="var(--spacing-sm)">
                  <Typography variant="body-sm" weight="medium">
                    {t('permissions.presetsTitle')}
                  </Typography>

                  <Stack direction="row" gap="var(--spacing-2xs)" wrap>
                    {categories.map((item) => (
                      <Button
                        key={item}
                        size="sm"
                        variant={category === item ? 'primary' : 'ghost'}
                        onClick={() => setCategory(item)}
                      >
                        {t(`permissions.category_${item}`)}
                      </Button>
                    ))}
                  </Stack>

                  <Stack gap="var(--spacing-2xs)">
                    {visiblePresets.map((preset) => (
                      <Stack
                        key={preset.id}
                        direction="row"
                        align="center"
                        justify="between"
                        gap="var(--spacing-sm)"
                        className={styles.presetRow}
                        role="button"
                        tabIndex={0}
                        onClick={() => setPattern(preset.pattern)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') setPattern(preset.pattern);
                        }}
                      >
                        <Stack gap="var(--spacing-3xs)">
                          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                            <Typography variant="body-sm" weight="medium" as="span">
                              {preset.title}
                            </Typography>
                            <Badge tone={RISK_TONE[preset.risk]}>
                              {t(`permissions.risk_${preset.risk}`)}
                            </Badge>
                          </Stack>
                          <Typography variant="caption" color="subtle" as="span">
                            {preset.description}
                          </Typography>
                        </Stack>

                        <Typography variant="mono" color="muted" as="span">
                          {preset.pattern}
                        </Typography>
                      </Stack>
                    ))}
                  </Stack>
                </Stack>
              </Card>
            )}

            <TextField
              label={t('permissions.pattern')}
              value={pattern}
              onChange={setPattern}
              placeholder="Bash(git push:*)"
              hint={t('permissions.patternHint')}
              isMono
              autoFocus={Boolean(rule)}
            />

            <Stack gap="var(--spacing-2xs)">
              <Typography variant="body-sm" weight="medium" as="span">
                {t('permissions.decision')}
              </Typography>

              <Stack direction="row" gap="var(--spacing-2xs)" wrap>
                {DECISIONS.map((item) => (
                  <Button
                    key={item}
                    size="sm"
                    variant={decision === item ? 'primary' : 'secondary'}
                    onClick={() => setDecision(item)}
                  >
                    {t(`permissions.${item}`)}
                  </Button>
                ))}
              </Stack>

              <Typography variant="caption" color="subtle">
                {t(`permissions.decisionHint_${decision}`)}
              </Typography>
            </Stack>

            {(create.isError || update.isError) && (
              <Typography variant="body-sm" color="danger">
                {t('errors.saveFailed')}
              </Typography>
            )}
          </Stack>
        </FormWithAssistant>
      )}
    </Modal>
  );
}
