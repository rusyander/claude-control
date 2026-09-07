import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestPlan } from '@agentdeck/contracts';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { DatePicker } from '@shared/ui/date-picker';
import type { TestPlanEditorProps } from './TestPlanEditor.types';
import styles from './TestPlans.module.scss';

/**
 * Правка тест-плана.
 *
 * Состав задаётся ОДНИМ из двух способов: отмеченный вручную список кейсов или
 * сохранённый набор-фильтр. Разрешить оба одновременно значит завести вопрос
 * «что сильнее», на который нет правильного ответа: план либо зафиксирован
 * поимённо (регресс перед релизом), либо описан правилом и растёт вместе с
 * библиотекой (дымовой набор).
 */
export function TestPlanEditor({
  isOpen,
  onOpenChange,
  plan,
  groups,
  views,
  environments,
  onSave,
}: TestPlanEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ProjectTestPlan>(blank());
  const [viewId, setViewId] = useState('');
  const [mode, setMode] = useState<'static' | 'dynamic'>('static');

  useEffect(() => {
    if (!isOpen) return;
    const next = plan ?? blank();
    setDraft({ ...next });
    setMode(next.filter ? 'dynamic' : 'static');
    setViewId(views.find((item) => sameFilter(item.filter, next.filter))?.id ?? '');
  }, [isOpen, plan, views]);

  const patch = (part: Partial<ProjectTestPlan>): void =>
    setDraft((current) => ({ ...current, ...part }));

  const toggleCase = (caseId: string): void => {
    const current = draft.caseIds ?? [];
    patch({
      caseIds: current.includes(caseId)
        ? current.filter((item) => item !== caseId)
        : [...current, caseId],
    });
  };

  const toggleEnvironment = (id: string): void => {
    const current = draft.environmentIds ?? [];
    patch({
      environmentIds: current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    });
  };

  const save = (): void => {
    const chosen = views.find((item) => item.id === viewId);
    onSave({
      ...draft,
      title: draft.title.trim(),
      updatedAt: new Date().toISOString(),
      ...(mode === 'dynamic'
        ? { filter: chosen?.filter ?? {}, caseIds: [] }
        : { filter: undefined }),
    });
    onOpenChange(false);
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={plan ? t('tests.plans.edit') : t('tests.plans.create')}
      size="xl"
      footer={
        <Stack direction="row" gap="var(--spacing-xs)" justify="end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!draft.title.trim()} onClick={save}>
            {t('projectTests.save')}
          </Button>
        </Stack>
      }
    >
      <Stack gap="var(--spacing-sm)">
        <TextField
          label={t('tests.plans.title')}
          value={draft.title}
          onChange={(value) => patch({ title: value })}
          autoFocus
        />

        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          <div className={styles.halfField}>
            <TextField
              label={t('tests.plans.product')}
              value={draft.product ?? ''}
              onChange={(value) => patch({ product: value })}
            />
          </div>
          <div className={styles.halfField}>
            <TextField
              label={t('tests.plans.version')}
              value={draft.version ?? ''}
              onChange={(value) => patch({ version: value })}
            />
          </div>
        </Stack>

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('tests.plans.dates')}
          </Typography>
          <DatePicker
            mode="range"
            value={{ from: draft.from, to: draft.to }}
            onChange={(value) => patch({ from: value.from, to: value.to })}
            placeholder={t('tests.plans.datesPlaceholder')}
            ariaLabel={t('tests.plans.dates')}
            isActive={Boolean(draft.from || draft.to)}
          />
        </Stack>

        <TextField
          label={t('tests.plans.description')}
          value={draft.description ?? ''}
          onChange={(value) => patch({ description: value })}
          multiline
          rows={3}
        />

        <TextField
          label={t('tests.editor.tags')}
          hint={t('tests.editor.tagsHint')}
          value={(draft.tags ?? []).join(', ')}
          onChange={(value) =>
            patch({
              tags: value
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean),
            })
          }
        />

        <SelectField
          label={t('tests.plans.mode')}
          hint={t('tests.plans.modeHint')}
          value={mode}
          onChange={(value) => setMode(value as 'static' | 'dynamic')}
          options={[
            { value: 'static', label: t('tests.plans.modeStatic') },
            { value: 'dynamic', label: t('tests.plans.modeDynamic') },
          ]}
        />

        {mode === 'dynamic' && (
          <SelectField
            label={t('tests.plans.view')}
            value={viewId}
            onChange={setViewId}
            options={[
              { value: '', label: t('tests.plans.viewNone') },
              ...views.map((item) => ({ value: item.id, label: item.title })),
            ]}
          />
        )}

        {mode === 'static' && (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('tests.plans.cases', { count: (draft.caseIds ?? []).length })}
            </Typography>
            <div className={styles.picker}>
              {groups.map((group) => (
                <Stack key={group.id} gap="var(--spacing-3xs)">
                  <Typography variant="caption" color="subtle">
                    {group.title}
                  </Typography>
                  {group.cases
                    .filter((item) => !item.archived)
                    .map((item) => (
                      <label key={item.id} className={styles.pickerRow}>
                        <input
                          type="checkbox"
                          checked={(draft.caseIds ?? []).includes(item.id)}
                          onChange={() => toggleCase(item.id)}
                        />
                        <Typography variant="body-sm" as="span">
                          {item.title}
                        </Typography>
                      </label>
                    ))}
                </Stack>
              ))}
            </div>
          </Stack>
        )}

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('tests.plans.environments')}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('tests.plans.environmentsHint')}
          </Typography>
          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            {environments.length === 0 && (
              <Typography variant="caption" color="subtle">
                {t('tests.plans.environmentsEmpty')}
              </Typography>
            )}
            {environments.map((item) => (
              <label key={item.id} className={styles.pickerRow}>
                <input
                  type="checkbox"
                  checked={(draft.environmentIds ?? []).includes(item.id)}
                  onChange={() => toggleEnvironment(item.id)}
                />
                <Typography variant="body-sm" as="span">
                  {item.title}
                </Typography>
              </label>
            ))}
          </Stack>
        </Stack>
      </Stack>
    </Modal>
  );
}

function blank(): ProjectTestPlan {
  return {
    id: `plan-${Date.now().toString(36)}`,
    title: '',
    caseIds: [],
    environmentIds: [],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Совпадает ли сохранённый набор с тем, что уже стоит в плане.
 *
 * Сравниваются сами условия, а не ссылка на набор: план хранит РЕЗУЛЬТАТ выбора
 * («вот такой фильтр»), а не идентификатор набора — иначе удаление набора
 * ломало бы состав плана задним числом.
 */
function sameFilter(left: ProjectTestPlan['filter'], right: ProjectTestPlan['filter']): boolean {
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}
