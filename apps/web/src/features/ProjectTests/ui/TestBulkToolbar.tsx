import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestBulkInput } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { SelectField } from '@shared/ui/select-field';
import { TextField } from '@shared/ui/text-field';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import type { TestBulkToolbarProps } from './TestBulkToolbar.types';
import styles from './ProjectTests.module.scss';

/** Действия, которым нужно значение, и откуда это значение берётся. */
type BulkAction = ProjectTestBulkInput['action'];

const VALUE_FROM: Record<
  BulkAction,
  'none' | 'text' | 'priority' | 'readiness' | 'automation' | 'section' | 'group'
> = {
  tag: 'text',
  untag: 'text',
  priority: 'priority',
  readiness: 'readiness',
  automation: 'automation',
  section: 'section',
  move: 'group',
  duplicate: 'none',
  archive: 'none',
  restore: 'none',
  delete: 'none',
};

/**
 * Панель массовых действий.
 *
 * Появляется только когда что-то отмечено, и всегда говорит СКОЛЬКО отмечено:
 * массовое действие без числа перед глазами — это способ поправить триста
 * кейсов вместо трёх. Удаление отдельно подтверждается по той же причине.
 */
export function TestBulkToolbar({
  checked,
  groupId,
  groups,
  sections,
  onApply,
  onClear,
}: TestBulkToolbarProps) {
  const { t } = useTranslation();
  const [action, setAction] = useState<BulkAction>('tag');
  const [value, setValue] = useState('');
  const [isRemoving, setRemoving] = useState(false);
  const [isBusy, setBusy] = useState(false);

  if (checked.length === 0) return null;

  const kind = VALUE_FROM[action];
  const needsValue = kind !== 'none';

  const run = async (next: BulkAction, nextValue?: string): Promise<void> => {
    setBusy(true);
    try {
      await onApply({ groupId, caseIds: checked, action: next, value: nextValue });
      setValue('');
    } finally {
      setBusy(false);
    }
  };

  const options = (values: readonly string[], prefix: string) =>
    values.map((item) => ({ value: item, label: t(`${prefix}.${item}`) }));

  return (
    <Stack direction="row" gap="var(--spacing-xs)" align="end" wrap className={styles.bulk}>
      <Typography variant="body-sm" weight="medium" as="span" className={styles.bulkCount}>
        {t('tests.bulk.selected', { count: checked.length })}
      </Typography>

      <SelectField
        label={t('tests.bulk.action')}
        value={action}
        onChange={(next) => {
          setAction(next as BulkAction);
          setValue('');
        }}
        options={options(ACTIONS, 'tests.bulk.actions')}
      />

      {kind === 'text' && (
        <TextField label={t('tests.bulk.tagValue')} value={value} onChange={setValue} />
      )}
      {kind === 'priority' && (
        <SelectField
          label={t('tests.library.priority')}
          value={value || 'medium'}
          onChange={setValue}
          options={options(PRIORITIES, 'tests.priority')}
        />
      )}
      {kind === 'readiness' && (
        <SelectField
          label={t('tests.library.readiness')}
          value={value || 'ready'}
          onChange={setValue}
          options={options(READINESS, 'tests.readiness')}
        />
      )}
      {kind === 'automation' && (
        <SelectField
          label={t('tests.library.automation')}
          value={value || 'manual'}
          onChange={setValue}
          options={options(AUTOMATION, 'tests.automation')}
        />
      )}
      {kind === 'section' && (
        <TextField
          label={t('tests.bulk.sectionValue')}
          hint={sections.slice(0, 3).join(' · ')}
          value={value}
          onChange={setValue}
        />
      )}
      {kind === 'group' && (
        <SelectField
          label={t('tests.bulk.groupValue')}
          value={value}
          onChange={setValue}
          options={[
            { value: '', label: t('tests.bulk.pickGroup') },
            ...groups
              .filter((group) => group.id !== groupId)
              .map((group) => ({ value: group.id, label: group.title })),
          ]}
        />
      )}

      <Button
        variant="primary"
        size="sm"
        isLoading={isBusy}
        disabled={needsValue && !normalized(kind, value)}
        onClick={() => {
          if (action === 'delete') {
            setRemoving(true);
            return;
          }
          void run(action, needsValue ? normalized(kind, value) : undefined);
        }}
      >
        {t('tests.bulk.apply')}
      </Button>

      <Button
        variant="ghost"
        size="sm"
        leftIcon={<Icon name="close" size={16} />}
        onClick={onClear}
      >
        {t('projectTests.clearSelection')}
      </Button>

      <ConfirmDialog
        isOpen={isRemoving}
        onOpenChange={setRemoving}
        title={t('tests.bulk.deleteConfirm', { count: checked.length })}
        description={t('tests.bulk.deleteText')}
        confirmLabel={t('common.delete')}
        onConfirm={() => {
          setRemoving(false);
          void run('delete');
        }}
      />
    </Stack>
  );
}

const ACTIONS: readonly BulkAction[] = [
  'tag',
  'untag',
  'priority',
  'readiness',
  'automation',
  'section',
  'move',
  'duplicate',
  'archive',
  'restore',
  'delete',
];
const PRIORITIES: readonly string[] = ['blocker', 'high', 'medium', 'low'];
const READINESS: readonly string[] = ['draft', 'ready', 'obsolete'];
const AUTOMATION: readonly string[] = ['manual', 'toAutomate', 'automated'];

/** Значение действия с подставленным умолчанием списка: пустой select — не выбор. */
function normalized(kind: string, value: string): string {
  if (value) return value.trim();
  if (kind === 'priority') return 'medium';
  if (kind === 'readiness') return 'ready';
  if (kind === 'automation') return 'manual';
  return '';
}
