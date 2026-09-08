import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestPlanRecipe } from '@agentdeck/contracts';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { SearchField } from '@shared/ui/search-field';
import { SelectField } from '@shared/ui/select-field';
import { useBuildTestPlan } from '@entities/ProjectTest';
import type { TestPlanRecipeModalProps } from './TestPlanRecipeModal.types';
import styles from './TestPlans.module.scss';

const RECIPES: ProjectTestPlanRecipe[] = ['smoke', 'diff', 'release', 'flaky'];

/**
 * Сборка плана правилом: дым за N минут, регрессия по диффу, план вехи,
 * нестабильные.
 *
 * Ноль токенов: агент здесь не участвует ни на одном шаге. План — это отбор по
 * счётным признакам, и правило считает его мгновенно, одинаково и проверяемо, а
 * агент добавил бы только разброс и расход окна.
 *
 * Сначала ПРЕДПРОСМОТР и только потом сохранение. Главное в предпросмотре —
 * левая колонка «не влезло»: она отвечает на вопрос, ради которого план и
 * собирают, — «а что я тогда не проверю».
 */
export function TestPlanRecipeModal({
  isOpen,
  onOpenChange,
  projectPath,
  environments,
}: TestPlanRecipeModalProps) {
  const { t } = useTranslation();
  const build = useBuildTestPlan(projectPath);

  const [recipe, setRecipe] = useState<ProjectTestPlanRecipe>('smoke');
  const [budget, setBudget] = useState('30');
  const [release, setRelease] = useState('');
  const [threshold, setThreshold] = useState('80');
  const [environmentId, setEnvironmentId] = useState('');
  const [title, setTitle] = useState('');

  const preview = build.data?.preview;
  const saved = build.data?.plan;

  const payload = (save: boolean) => ({
    recipe,
    budget: recipe === 'smoke' ? numberOr(budget, 30) : undefined,
    release: recipe === 'release' ? release.trim() || undefined : undefined,
    // Порог человек вводит процентами, а договор — доля: 80 значит 0.8.
    threshold: recipe === 'flaky' ? numberOr(threshold, 80) / 100 : undefined,
    environmentId: environmentId || undefined,
    title: title.trim() || undefined,
    save,
  });

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('tests.plans.recipeTitle')}
      description={t('tests.plans.recipeHint')}
      size="lg"
    >
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" gap="var(--spacing-xs)" align="end" wrap>
          <SelectField
            label={t('tests.plans.recipe')}
            value={recipe}
            onChange={(value) => setRecipe(value as ProjectTestPlanRecipe)}
            options={RECIPES.map((item) => ({
              value: item,
              label: t(`tests.plans.recipes.${item}`),
            }))}
          />

          {recipe === 'smoke' && (
            <SearchField
              label={t('tests.plans.budget')}
              placeholder="30"
              value={budget}
              onChange={setBudget}
            />
          )}
          {recipe === 'release' && (
            <SearchField
              label={t('tests.runs.release')}
              placeholder={t('tests.runs.releaseHint')}
              value={release}
              onChange={setRelease}
            />
          )}
          {recipe === 'flaky' && (
            <SearchField
              label={t('tests.plans.threshold')}
              placeholder="80"
              value={threshold}
              onChange={setThreshold}
            />
          )}

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

          <SearchField
            label={t('tests.plans.title')}
            placeholder={t(`tests.plans.recipes.${recipe}`)}
            value={title}
            onChange={setTitle}
          />
        </Stack>

        <Typography variant="caption" color="subtle">
          {t(`tests.plans.recipeAbout.${recipe}`)}
        </Typography>

        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Button
            variant="secondary"
            isLoading={build.isPending}
            onClick={() => build.mutate(payload(false))}
          >
            {t('tests.plans.recipePreview')}
          </Button>
          <Button
            variant="primary"
            disabled={build.isPending || !preview || preview.picked.length === 0}
            onClick={() => build.mutate(payload(true))}
          >
            {t('tests.plans.recipeSave')}
          </Button>
          {saved && (
            <Typography variant="caption" color="success" as="span">
              {t('tests.plans.recipeSaved', { title: saved.title })}
            </Typography>
          )}
        </Stack>

        {build.error && (
          <Typography variant="caption" color="danger">
            {messageOf(build.error)}
          </Typography>
        )}

        {preview && (
          <Stack gap="var(--spacing-2xs)">
            <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
              <Badge tone="accent">
                {t('tests.plans.recipePicked', { count: preview.picked.length })}
              </Badge>
              <Badge tone="neutral">
                {t('tests.plans.recipeMinutes', { minutes: preview.minutes })}
              </Badge>
              {preview.budget !== undefined && (
                <Typography variant="caption" color="subtle" as="span">
                  {t('tests.plans.recipeBudget', { minutes: preview.budget })}
                </Typography>
              )}
            </Stack>

            {preview.picked.length === 0 && (
              <Typography variant="caption" color="warning">
                {t('tests.plans.recipeNothing')}
              </Typography>
            )}

            {preview.picked.map((item) => (
              <Stack
                key={`${item.groupId}:${item.caseId}`}
                direction="row"
                gap="var(--spacing-2xs)"
                align="center"
                wrap
                className={styles.previewRow}
              >
                <Typography variant="body-sm" as="span">
                  {item.title}
                </Typography>
                <Typography variant="caption" color="subtle" as="span">
                  {item.reason}
                </Typography>
              </Stack>
            ))}

            {/* Не влезло — вторая половина ответа, а не примечание: план без
                неё выглядит полным, а на деле это выбор, чего не проверять. */}
            {preview.left.length > 0 && (
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body-sm" weight="medium">
                  {t('tests.plans.recipeLeft', { count: preview.left.length })}
                </Typography>
                {preview.left.slice(0, 30).map((item) => (
                  <Typography
                    key={`${item.groupId}:${item.caseId}`}
                    variant="caption"
                    color="subtle"
                  >
                    {item.title} — {item.reason}
                  </Typography>
                ))}
              </Stack>
            )}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}

function numberOr(value: string, fallback: number): number {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Текст отказа сервера одной строкой — например «правила „магия“ нет». */
function messageOf(error: unknown): string {
  const response = (error as { response?: { data?: { message?: string } } }).response;
  return response?.data?.message ?? (error as Error).message;
}
