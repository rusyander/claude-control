import { useTranslation } from 'react-i18next';
import type { ProjectTestCase } from '@agentdeck/contracts';
import { combineParams } from '@agentdeck/contracts/test-format';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { EmptyState } from '@shared/ui/empty-state';
import { AUTOMATION_TONE, PRIORITY_TONE, READINESS_TONE, STATUS_TONE } from '@entities/ProjectTest';
import type { TestCaseTableProps } from './TestCaseTable.types';
import styles from './ProjectTests.module.scss';

/**
 * Таблица кейсов.
 *
 * Колонки за пределами обязательных задаёт `schema.json` проекта: свои поля
 * («компонент», «релиз») видны в списке, а не только в форме, — иначе завести
 * их можно, а отобрать по ним глазами нельзя.
 *
 * Число проходов считается тем же `combineParams`, что и на сервере: кейс с
 * параметрами разворачивается в несколько тест-поинтов, и в списке должно быть
 * видно, что «один кейс» на самом деле означает восемь прогонов.
 */
export function TestCaseTable({
  rows,
  total,
  checked,
  onToggle,
  onCheckAll,
  onClearChecked,
  attributes,
  onEdit,
  onRemove,
  withGroup,
}: TestCaseTableProps) {
  const { t } = useTranslation();

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="check"
        title={t('tests.library.empty')}
        text={total > 0 ? t('tests.library.emptyFiltered') : t('tests.library.emptyGroup')}
      />
    );
  }

  const isAllChecked = rows.every((row) => checked.includes(row.testCase.id));

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className={styles.tableCaption}>
          {t('tests.library.countOf', { shown: rows.length, total })}
        </caption>
        <thead>
          <tr>
            <th scope="col" className={styles.cellCheck}>
              <input
                type="checkbox"
                checked={isAllChecked}
                onChange={() => (isAllChecked ? onClearChecked() : onCheckAll())}
                aria-label={t('tests.library.checkAll')}
              />
            </th>
            <th scope="col">{t('tests.library.columnTitle')}</th>
            {withGroup && <th scope="col">{t('tests.library.columnGroup')}</th>}
            <th scope="col">{t('tests.library.columnStatus')}</th>
            <th scope="col">{t('tests.library.columnPriority')}</th>
            <th scope="col">{t('tests.library.columnReadiness')}</th>
            <th scope="col">{t('tests.library.columnAutomation')}</th>
            <th scope="col">{t('tests.library.columnArea')}</th>
            <th scope="col">{t('tests.library.columnPoints')}</th>
            {attributes.map((attribute) => (
              <th scope="col" key={attribute.key}>
                {attribute.title}
              </th>
            ))}
            <th scope="col">
              <span className={styles.visuallyHidden}>{t('tests.library.columnActions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const item = row.testCase;
            return (
              <tr
                key={`${row.groupId}:${item.id}`}
                className={[
                  styles.tableRow,
                  item.status === 'failed' ? styles.tableRowFailed : '',
                  item.archived ? styles.tableRowArchived : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <td className={styles.cellCheck}>
                  <input
                    type="checkbox"
                    checked={checked.includes(item.id)}
                    onChange={() => onToggle(item.id)}
                    aria-label={item.title}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className={styles.caseLink}
                    onClick={() => onEdit(item, row.groupId)}
                  >
                    <Typography variant="body-sm" weight="medium" as="span">
                      {item.title}
                    </Typography>
                  </button>
                  <Stack direction="row" gap="var(--spacing-3xs)" align="center" wrap>
                    {item.section && (
                      <Typography variant="caption" color="subtle" as="span">
                        {item.section}
                      </Typography>
                    )}
                    {item.type === 'checklist' && (
                      <Badge tone="neutral">{t('tests.kind.checklist')}</Badge>
                    )}
                    {(item.tags ?? []).map((tag) => (
                      <Badge key={tag} tone="neutral">
                        {tag}
                      </Badge>
                    ))}
                  </Stack>
                </td>
                {withGroup && (
                  <td>
                    <Typography variant="caption" color="subtle" as="span">
                      {row.groupTitle}
                    </Typography>
                  </td>
                )}
                <td>
                  <Badge tone={STATUS_TONE[item.status]}>
                    {t(`projectTests.status.${item.status}`)}
                  </Badge>
                </td>
                <td>
                  <Badge tone={PRIORITY_TONE[item.priority ?? 'medium']}>
                    {t(`tests.priority.${item.priority ?? 'medium'}`)}
                  </Badge>
                </td>
                <td>
                  <Badge tone={READINESS_TONE[item.readiness ?? 'draft']}>
                    {t(`tests.readiness.${item.readiness ?? 'draft'}`)}
                  </Badge>
                </td>
                <td>
                  <Badge tone={AUTOMATION_TONE[item.automation?.status ?? 'manual']}>
                    {t(`tests.automation.${item.automation?.status ?? 'manual'}`)}
                  </Badge>
                </td>
                <td>
                  <Typography variant="caption" color="subtle" as="span">
                    {item.area ?? '—'}
                  </Typography>
                </td>
                <td>
                  <Typography variant="caption" color="subtle" as="span">
                    {pointsOf(item)}
                  </Typography>
                </td>
                {attributes.map((attribute) => (
                  <td key={attribute.key}>
                    <Typography variant="caption" color="subtle" as="span">
                      {item.attributes?.[attribute.key] ?? '—'}
                    </Typography>
                  </td>
                ))}
                <td>
                  <Stack direction="row" gap="var(--spacing-3xs)">
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon={<Icon name="edit" size={16} />}
                      aria-label={t('projectTests.editCase')}
                      onClick={() => onEdit(item, row.groupId)}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon={<Icon name="trash" size={16} />}
                      aria-label={t('projectTests.removeCase')}
                      onClick={() => onRemove(item, row.groupId)}
                    />
                  </Stack>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Во сколько проходов разворачивается кейс: полный перебор его параметров. */
function pointsOf(item: ProjectTestCase): number {
  const combos = combineParams(item.parameters ?? []);
  return combos.length > 0 ? combos.length : 1;
}
