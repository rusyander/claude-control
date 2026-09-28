import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestBulkInput } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import type { TestBulkToolbarProps } from './TestBulkToolbar.types';
import styles from './ProjectTests.module.scss';

/** Действия, которым нужно значение, и откуда это значение берётся. */
type BulkAction = ProjectTestBulkInput['action'];

const VALUE_FROM: Record<
  BulkAction,
  'none' | 'text' | 'reason' | 'priority' | 'readiness' | 'automation' | 'section' | 'group'
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
  // Причина карантина обязательна — её требует и сервер: карантин без
  // объяснения через месяц никто не решится снять, потому что неизвестно, чего
  // он ждал.
  mute: 'reason',
  unmute: 'none',
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

  // Поля без подписей сверху — как в пульте прогона: подпись над каждым полем
  // делала из панели блок в 80–145px, который сдвигал таблицу вниз при каждой
  // отметке строки. Что за поле — говорят aria-label и плейсхолдер, подсказка
  // целиком — во всплывающей подсказке.
  const select = (label: string, current: string, items: { value: string; label: string }[]) => (
    <select
      className={styles.bulkControl}
      aria-label={label}
      title={label}
      value={current}
      onChange={(event) => setValue(event.target.value)}
    >
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  );
  const input = (label: string, hint: string) => (
    <input
      className={`${styles.bulkControl} ${styles.bulkInput}`}
      type="text"
      aria-label={label}
      title={hint}
      placeholder={hint}
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );

  return (
    <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap className={styles.bulk}>
      <Typography variant="body-sm" weight="medium" as="span" className={styles.bulkCount}>
        {t('tests.bulk.selected', { count: checked.length })}
      </Typography>

      <select
        className={styles.bulkControl}
        aria-label={t('tests.bulk.action')}
        title={t('tests.bulk.action')}
        value={action}
        onChange={(event) => {
          setAction(event.target.value as BulkAction);
          setValue('');
        }}
      >
        {options(ACTIONS, 'tests.bulk.actions').map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>

      {kind === 'text' && input(t('tests.bulk.tagValue'), t('tests.bulk.tagValue'))}
      {kind === 'reason' && input(t('tests.bulk.muteReason'), t('tests.bulk.muteReasonHint'))}
      {kind === 'priority' &&
        select(
          t('tests.library.priority'),
          value || 'medium',
          options(PRIORITIES, 'tests.priority'),
        )}
      {kind === 'readiness' &&
        select(
          t('tests.library.readiness'),
          value || 'ready',
          options(READINESS, 'tests.readiness'),
        )}
      {kind === 'automation' &&
        select(
          t('tests.library.automation'),
          value || 'manual',
          options(AUTOMATION, 'tests.automation'),
        )}
      {kind === 'section' &&
        input(
          t('tests.bulk.sectionValue'),
          sections.length > 0
            ? `${t('tests.bulk.sectionValue')}: ${sections.slice(0, 3).join(' · ')}`
            : t('tests.bulk.sectionValue'),
        )}
      {kind === 'group' &&
        select(t('tests.bulk.groupValue'), value, [
          { value: '', label: t('tests.bulk.pickGroup') },
          ...groups
            .filter((group) => group.id !== groupId)
            .map((group) => ({ value: group.id, label: group.title })),
        ])}

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
  'mute',
  'unmute',
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
