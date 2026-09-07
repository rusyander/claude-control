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
export function TestFilterBar({ filters, views, onSaveView, onRemoveView }: TestFilterBarProps) {
  const { t } = useTranslation();
  const [isSaveOpen, setSaveOpen] = useState(false);
  const [viewTitle, setViewTitle] = useState('');

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

        {filters.isActive && (
          <Button variant="ghost" size="sm" onClick={filters.reset}>
            {t('tests.library.reset')}
          </Button>
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

/** Первое значение списка фильтра — `select` показывает одно. */
function first(list: readonly string[] | undefined): string {
  return list?.[0] ?? '';
}

/** Значение `select` обратно в список фильтра; пусто — поля в фильтре нет. */
function wrap<T extends string>(value: string): T[] | undefined {
  return value ? [value as T] : undefined;
}
