import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestPlan } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { SelectField } from '@shared/ui/select-field';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import {
  useRemoveTestPlan,
  useSaveTestPlan,
  useTestPlanPoints,
  useTestPlans,
} from '@entities/ProjectTest';
import { TestPlanEditor } from './TestPlanEditor';
import { TestPlanRecipeModal } from './TestPlanRecipeModal';
import type { TestPlansPanelProps } from './TestPlansPanel.types';
import styles from './TestPlans.module.scss';

/**
 * Тест-планы проекта.
 *
 * У каждого плана показано, во сколько ПРОХОДОВ он разворачивается, и считает
 * это сервер: план из двадцати кейсов на трёх окружениях — это шестьдесят
 * проходов, и решение «успеем ли к пятнице» принимается по этому числу, а не по
 * числу кейсов. Считается оно для выбранного окружения: смена окружения меняет
 * объём работы, и это должно быть видно до запуска.
 */
export function TestPlansPanel({
  projectPath,
  groups,
  views,
  environments,
  onStartAgent,
  onStartManual,
}: TestPlansPanelProps) {
  const { t } = useTranslation();
  const plans = useTestPlans(projectPath);
  const save = useSaveTestPlan(projectPath);
  const remove = useRemoveTestPlan(projectPath);

  const [selectedId, setSelectedId] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [editing, setEditing] = useState<ProjectTestPlan | undefined>();
  const [isEditorOpen, setEditorOpen] = useState(false);
  const [removing, setRemoving] = useState<ProjectTestPlan | undefined>();
  const [isRecipeOpen, setRecipeOpen] = useState(false);

  const list = plans.data ?? [];
  const selected = list.find((item) => item.id === selectedId) ?? list[0];
  const points = useTestPlanPoints(projectPath, selected?.id, environmentId || undefined);

  const open = (plan?: ProjectTestPlan): void => {
    setEditing(plan);
    setEditorOpen(true);
  };

  if (plans.isLoading) return <SkeletonList rows={3} />;

  return (
    <Stack gap="var(--spacing-sm)">
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        <Button
          variant="primary"
          leftIcon={<Icon name="plus" size={18} />}
          onClick={() => open(undefined)}
        >
          {t('tests.plans.create')}
        </Button>
        {/* Правилом — рядом с «создать»: это тот же план, только отобранный
            счётом, а не руками. Токенов не стоит и работает офлайн. */}
        <Button
          variant="secondary"
          leftIcon={<Icon name="sandbox" size={18} />}
          title={t('tests.plans.recipeHint')}
          onClick={() => setRecipeOpen(true)}
        >
          {t('tests.plans.recipeOpen')}
        </Button>
        {environments.length > 0 && (
          <SelectField
            label={t('tests.runs.environment')}
            value={environmentId}
            onChange={setEnvironmentId}
            options={[
              { value: '', label: t('tests.runs.environmentAll') },
              ...environments.map((item) => ({ value: item.id, label: item.title })),
            ]}
          />
        )}
      </Stack>

      {list.length === 0 && (
        <EmptyState
          icon="calendar"
          title={t('tests.plans.empty')}
          text={t('tests.plans.emptyHint')}
        />
      )}

      <div className={styles.grid}>
        {list.map((plan) => (
          <Card
            key={plan.id}
            isRaised={plan.id === selected?.id}
            isInteractive
            padding="md"
            onClick={() => setSelectedId(plan.id)}
          >
            <Stack gap="var(--spacing-2xs)">
              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                <Typography variant="body" weight="medium">
                  {plan.title}
                </Typography>
                {plan.version && <Badge tone="neutral">{plan.version}</Badge>}
                {plan.filter && <Badge tone="info">{t('tests.plans.modeDynamic')}</Badge>}
                {plan.locked && <Badge tone="warning">{t('tests.plans.locked')}</Badge>}
              </Stack>

              {plan.description && (
                <Typography variant="caption" color="subtle" clamp={2}>
                  {plan.description}
                </Typography>
              )}

              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                {plan.product && (
                  <Typography variant="caption" color="subtle" as="span">
                    {plan.product}
                  </Typography>
                )}
                {(plan.from || plan.to) && (
                  <Typography variant="caption" color="subtle" as="span">
                    {`${plan.from ?? '…'} — ${plan.to ?? '…'}`}
                  </Typography>
                )}
                <Typography variant="caption" color="subtle" as="span">
                  {t('tests.plans.caseCount', { count: (plan.caseIds ?? []).length })}
                </Typography>
                {plan.id === selected?.id && (
                  <Badge tone="accent">
                    {t('tests.plans.points', { count: points.data?.length ?? 0 })}
                  </Badge>
                )}
              </Stack>

              {plan.id === selected?.id && (
                <Stack direction="row" gap="var(--spacing-2xs)" wrap>
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<Icon name="check" size={16} />}
                    onClick={() => onStartManual(plan.id, environmentId || undefined)}
                  >
                    {t('tests.plans.startManual')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<Icon name="sandbox" size={16} />}
                    onClick={() => onStartAgent(plan.id, environmentId || undefined)}
                  >
                    {t('tests.plans.startAgent')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={<Icon name="edit" size={16} />}
                    onClick={() => open(plan)}
                  >
                    {t('tests.plans.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={<Icon name="trash" size={16} />}
                    onClick={() => setRemoving(plan)}
                  >
                    {t('common.delete')}
                  </Button>
                </Stack>
              )}
            </Stack>
          </Card>
        ))}
      </div>

      <TestPlanEditor
        isOpen={isEditorOpen}
        onOpenChange={setEditorOpen}
        plan={editing}
        groups={groups}
        views={views}
        environments={environments}
        onSave={(plan) => save.mutate(plan)}
      />

      <TestPlanRecipeModal
        isOpen={isRecipeOpen}
        onOpenChange={setRecipeOpen}
        projectPath={projectPath}
        environments={environments}
      />

      <ConfirmDialog
        isOpen={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={t('tests.plans.removeConfirm', { title: removing?.title ?? '' })}
        description={t('tests.plans.removeText')}
        confirmLabel={t('common.delete')}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id);
          setRemoving(undefined);
        }}
      />
    </Stack>
  );
}
