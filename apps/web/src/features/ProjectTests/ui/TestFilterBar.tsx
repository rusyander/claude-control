import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ProjectTestAutomationStatus,
  ProjectTestKind,
  ProjectTestPriority,
  ProjectTestReadiness,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { PROJECT_TEST_STATUSES } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { SearchField } from '@shared/ui/search-field';
import { SelectField } from '@shared/ui/select-field';
import { TextField } from '@shared/ui/text-field';
import { Modal } from '@shared/ui/modal';
import type { TestFilterBarProps } from './TestFilterBar.types';
import styles from './ProjectTests.module.scss';

/**
 * Строка отбора и сохранённые наборы.
 *
 * Каждый список — обычный `select` с пустым первым значением: «любой» здесь
 * значит «не сужать», и это состояние по умолчанию. Множественный выбор
 * намеренно не делается — своего мультиселекта в наборе примитивов нет, а
 * заводить его ради фильтра значит завести компонент, который придётся чинить
 * при каждом обновлении браузера. Один тег, один статус, одна зона закрывают
 * работу тестировщика, а всё остальное набирается сохранённым набором.
 */
export function TestFilterBar({
  filters,
  views,
  onSaveView,
  onRemoveView,
  onPickBudget,
  budget,
}: TestFilterBarProps) {
  const { t } = useTranslation();
  const [isSaveOpen, setSaveOpen] = useState(false);
  const [viewTitle, setViewTitle] = useState('');
  const [minutes, setMinutes] = useState('30');

  const { filter, patch, facets } = filters;

  const anyOption = { value: '', label: t('tests.library.any') };
  const listOptions = (values: readonly string[], prefix: string) => [
    anyOption,
    ...values.map((value) => ({ value, label: t(`${prefix}.${value}`) })),
  ];
  const plainOptions = (values: string[]) => [
    anyOption,
    ...values.map((value) => ({ value, label: value })),
  ];

  const saveView = (): void => {
    const title = viewTitle.trim();
    if (!title) return;
    onSaveView({
      id: `view-${Date.now().toString(36)}`,
      title,
      filter,
      createdAt: new Date().toISOString(),
    });
    setViewTitle('');
    setSaveOpen(false);
  };

  return (
    <Stack gap="var(--spacing-2xs)" className={styles.filters}>
      <Stack direction="row" gap="var(--spacing-xs)" align="end" wrap>
        <div className={styles.query}>
          <SearchField
            label={t('tests.library.query')}
            placeholder={t('tests.library.queryHint')}
            value={filter.query ?? ''}
            onChange={(value) => patch({ query: value })}
          />
        </div>

        <SelectField
          label={t('tests.library.status')}
          value={first(filter.statuses)}
          onChange={(value) => patch({ statuses: wrap<ProjectTestStatus>(value) })}
          options={listOptions(PROJECT_TEST_STATUSES, 'projectTests.status')}
        />
        <SelectField
          label={t('tests.library.priority')}
          value={first(filter.priorities)}
          onChange={(value) => patch({ priorities: wrap<ProjectTestPriority>(value) })}
          options={listOptions(PRIORITIES, 'tests.priority')}
        />
        <SelectField
          label={t('tests.library.type')}
          value={first(filter.types)}
          onChange={(value) => patch({ types: wrap<ProjectTestKind>(value) })}
          options={listOptions(KINDS, 'tests.kind')}
        />
        <SelectField
          label={t('tests.library.readiness')}
          value={first(filter.readiness)}
          onChange={(value) => patch({ readiness: wrap<ProjectTestReadiness>(value) })}
          options={listOptions(READINESS, 'tests.readiness')}
        />
        <SelectField
          label={t('tests.library.automation')}
          value={first(filter.automation)}
          onChange={(value) => patch({ automation: wrap<ProjectTestAutomationStatus>(value) })}
          options={listOptions(AUTOMATION, 'tests.automation')}
        />
        <SelectField
          label={t('tests.library.area')}
          value={first(filter.areas)}
          onChange={(value) => patch({ areas: wrap<string>(value) })}
          options={plainOptions(facets.areas)}
        />
        <SelectField
          label={t('tests.library.tag')}
          value={first(filter.tags)}
          onChange={(value) => patch({ tags: wrap<string>(value) })}
          options={plainOptions(facets.tags)}
        />

        {/* Карантин отдельным списком, а не переключателем: спрашивают о нём
            три разных вопроса — «покажи всё», «покажи только карантин» (чтобы
            его разобрать) и «спрячь карантин» (чтобы видеть настоящую картину). */}
        <SelectField
          label={t('tests.library.muted')}
          value={mutedValue(filter.muted)}
          onChange={(value) => patch({ muted: mutedFilter(value) })}
          options={[
            anyOption,
            { value: 'only', label: t('tests.library.mutedOnly') },
            { value: 'without', label: t('tests.library.mutedWithout') },
          ]}
        />

        {/* «С замечаниями» — не поле фильтра, а взгляд на тот же список: линтер
            считает их по библиотеке сейчас, и в сохранённом наборе они значили
            бы кейсы, которых на чужой машине нет. */}
        {filters.hasFindings && (
          <Stack
            direction="row"
            gap="var(--spacing-2xs)"
            align="center"
            className={styles.archived}
          >
            <Toggle
              checked={filters.withFindings}
              onCheckedChange={filters.setWithFindings}
              aria-label={t('tests.health.filter')}
              size="sm"
            />
            <Typography
              variant="caption"
              color="subtle"
              as="span"
              title={t('tests.health.filterHint')}
            >
              {t('tests.health.filter')}
            </Typography>
          </Stack>
        )}

        <Stack direction="row" gap="var(--spacing-2xs)" align="center" className={styles.archived}>
          <Toggle
            checked={Boolean(filter.includeArchived)}
            onCheckedChange={(checked) => patch({ includeArchived: checked })}
            aria-label={t('tests.library.archived')}
            size="sm"
          />
          <Typography variant="caption" color="subtle" as="span">
            {t('tests.library.archived')}
          </Typography>
        </Stack>

        {/* Порядок — не фильтр: он ничего не убирает с экрана, а отвечает на
            другой вопрос — с чего начинать, когда времени на всё нет. */}
        <SelectField
          label={t('tests.risk.sort')}
          value={filters.sort}
          onChange={(value) => filters.setSort(value === 'risk' ? 'risk' : 'file')}
          options={[
            { value: 'file', label: t('tests.risk.sortFile') },
            { value: 'risk', label: t('tests.risk.sortRisk') },
          ]}
        />

        {filters.isActive && (
          <Button variant="ghost" size="sm" onClick={filters.reset}>
            {t('tests.library.reset')}
          </Button>
        )}
      </Stack>

      {/* «У меня N минут» отмечает кейсы, а не запускает прогон: запуск остаётся
          той же кнопкой пульта, и человек успевает посмотреть, что ему набрали. */}
      <Stack direction="row" gap="var(--spacing-xs)" align="end" wrap>
        <div className={styles.budget}>
          <TextField
            label={t('tests.risk.budget')}
            hint={t('tests.risk.budgetHint')}
            value={minutes}
            onChange={setMinutes}
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon name="calendar" size={16} />}
          disabled={budgetMinutes(minutes) === undefined}
          onClick={() => {
            const value = budgetMinutes(minutes);
            if (value !== undefined) onPickBudget(value);
          }}
        >
          {t('tests.risk.budgetApply')}
        </Button>

        {budget && (
          <Typography
            variant="caption"
            color={budget.left.length > 0 ? 'warning' : 'subtle'}
            as="span"
            // Полный список невлезшего — в подсказке: строка отбора не должна
            // расти на сто названий, но и молчать о них нельзя.
            title={budget.left.map((item) => `${item.title} — ${item.duration} мин`).join('\n')}
          >
            {t('tests.risk.budgetResult', {
              count: budget.picked,
              minutes: budget.minutes,
              budget: budget.budget,
              left: budget.left.length,
            })}
          </Typography>
        )}
      </Stack>

      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
        <Typography variant="caption" color="subtle" as="span">
          {t('tests.library.views')}
        </Typography>
        {views.length === 0 && (
          <Typography variant="caption" color="subtle" as="span">
            {t('tests.library.viewsEmpty')}
          </Typography>
        )}
        {views.map((view) => (
          <span key={view.id} className={styles.viewChip}>
            <button
              type="button"
              className={styles.viewApply}
              onClick={() => filters.apply(view.filter)}
            >
              <Badge tone="info">{view.title}</Badge>
            </button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="close" size={14} />}
              aria-label={t('tests.library.viewRemove', { title: view.title })}
              onClick={() => onRemoveView(view.id)}
            />
          </span>
        ))}
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Icon name="plus" size={16} />}
          disabled={!filters.isActive}
          title={t('tests.library.viewSaveHint')}
          onClick={() => setSaveOpen(true)}
        >
          {t('tests.library.viewSave')}
        </Button>
      </Stack>

      <Modal
        isOpen={isSaveOpen}
        onOpenChange={setSaveOpen}
        title={t('tests.library.viewSave')}
        description={t('tests.library.viewSaveHint')}
        size="sm"
        footer={
          <Stack direction="row" gap="var(--spacing-xs)" justify="end">
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={!viewTitle.trim()} onClick={saveView}>
              {t('projectTests.save')}
            </Button>
          </Stack>
        }
      >
        <TextField
          label={t('tests.library.viewName')}
          value={viewTitle}
          onChange={setViewTitle}
          autoFocus
        />
      </Modal>
    </Stack>
  );
}

const PRIORITIES: readonly string[] = ['blocker', 'high', 'medium', 'low'];
const KINDS: readonly string[] = ['case', 'checklist'];
const READINESS: readonly string[] = ['draft', 'ready', 'obsolete'];
const AUTOMATION: readonly string[] = ['manual', 'toAutomate', 'automated'];

/** Трёхзначный отбор карантина в значение `select` и обратно. */
function mutedValue(muted: boolean | undefined): string {
  if (muted === true) return 'only';
  if (muted === false) return 'without';
  return '';
}

function mutedFilter(value: string): boolean | undefined {
  if (value === 'only') return true;
  if (value === 'without') return false;
  return undefined;
}

/** Минуты бюджета из поля; мусор и ноль значат «набирать нечего». */
function budgetMinutes(value: string): number | undefined {
  const minutes = Number(value.replace(',', '.').trim());
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : undefined;
}

/** Первое значение списка фильтра — `select` показывает одно. */
function first(list: readonly string[] | undefined): string {
  return list?.[0] ?? '';
}

/** Значение `select` обратно в список фильтра; пусто — поля в фильтре нет. */
function wrap<T extends string>(value: string): T[] | undefined {
  return value ? [value as T] : undefined;
}
