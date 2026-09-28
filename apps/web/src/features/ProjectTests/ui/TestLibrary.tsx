import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestCase } from '@agentdeck/contracts';
import { useEntityUrl } from '@shared/hooks/use-entity-url';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { EmptyState } from '@shared/ui/empty-state';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { useTestFlakyMarks } from '@entities/ProjectTest';
import { flakyIndex } from '../model/caseResults';
import { TestFilterBar } from './TestFilterBar';
import { TestSectionTree } from './TestSectionTree';
import { TestGroupList } from './TestGroupList';
import { TestCaseTable } from './TestCaseTable';
import { TestBulkToolbar } from './TestBulkToolbar';
import { TestCaseEditor } from './TestCaseEditor';
import { TestHistoryModal } from './TestHistoryModal';
import { TestExchangeModal } from './TestExchangeModal';
import { TestGroupFormModal } from './TestGroupFormModal';
import type { TestLibraryProps } from './TestLibrary.types';
import styles from './ProjectTests.module.scss';
import { serverFieldText } from '@shared/config/i18n';

/**
 * Библиотека кейсов целиком: вкладки-группы, дерево секций, отбор, таблица.
 *
 * Один и тот же блок работает и в разделе «Тестирование», и в окне тестов из
 * чата: библиотека — это то, что человек открывает чаще всего, и второй её
 * реализации, которая молча разойдётся с первой, здесь нет.
 *
 * Группа — это файл в `.agent/tests/`, поэтому вкладки не настраиваются в
 * панели: завёл файл — появилась вкладка, и завести его может как человек
 * кнопкой, так и агент во время генерации.
 */
export function TestLibrary({ board, actions, empty }: TestLibraryProps) {
  const { t } = useTranslation();
  const [isGroupOpen, setGroupOpen] = useState(false);
  // Правка заведённой группы: то же окно, что и «Новая группа», с запертым id.
  const [isGroupEditing, setGroupEditing] = useState(false);
  const [isGroupRemoving, setGroupRemoving] = useState(false);
  const [editing, setEditing] = useState<ProjectTestCase | undefined>();
  // Группа открытого кейса: по ней карточка тянет историю результатов, а в
  // сквозном списке она не обязана совпадать с выбранной.
  const [editingGroupId, setEditingGroupId] = useState('');
  const [isCaseOpen, setCaseOpen] = useState(false);
  const [removing, setRemoving] = useState<ProjectTestCase | undefined>();
  const [isHistoryOpen, setHistoryOpen] = useState(false);
  const [isExchangeOpen, setExchangeOpen] = useState(false);
  // Отметки «нестабилен» и история кейса перечитываются, когда меняется
  // подпись последнего прогона: кончился прогон — вердикт мог смениться.
  const runStamp = `${board.run?.id ?? ''}:${board.run?.status ?? ''}`;
  const flakyMarks = useTestFlakyMarks(board.path, runStamp);
  const flaky = useMemo(() => flakyIndex(flakyMarks.data), [flakyMarks.data]);

  const openCase = (testCase?: ProjectTestCase, groupId = board.activeId): void => {
    setEditing(testCase);
    setEditingGroupId(groupId);
    setCaseOpen(true);
  };

  /**
   * Кейс, открытый ссылкой: `/tests?id=<группа>:<кейс>`. Так на кейс ссылается
   * общий поиск панели — идентификатор несёт и группу, потому что один и тот же
   * `id` кейса вполне может встретиться в двух файлах.
   */
  const linkable = useMemo(
    () =>
      board.groups.flatMap((group) =>
        group.cases.map((testCase) => ({ groupId: group.id, testCase })),
      ),
    [board.groups],
  );

  useEntityUrl({
    items: linkable,
    getId: (item) => `${item.groupId}:${item.testCase.id}`,
    onOpen: (item) => {
      board.select(item.groupId);
      openCase(item.testCase, item.groupId);
    },
  });

  const selectedSection = board.filters.filter.sections?.[0] ?? '';

  return (
    <div className={styles.library}>
      {/* Шапка открытой группы: её имя, файл и то, что делают с ней целиком.
          Сами группы — списком слева: ряд вкладок на двух десятках групп
          занимал пять строк и уводил кейсы за низ экрана. */}
      <Stack
        direction="row"
        gap="var(--spacing-2xs)"
        align="center"
        wrap
        className={`${styles.tabs} ${styles.narrowable}`}
      >
        {board.active && (
          <Stack gap="0" className={styles.groupHead}>
            <Typography
              variant="body"
              weight="medium"
              as="span"
              truncate
              title={board.active.title}
            >
              {board.active.title}
            </Typography>
            <Typography variant="caption" color="subtle" as="span" truncate>
              {t('tests.library.groupFile', { file: board.active.file })}
            </Typography>
          </Stack>
        )}
        {board.groups.length === 0 && (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Icon name="plus" size={18} />}
            onClick={() => setGroupOpen(true)}
          >
            {t('projectTests.addGroup')}
          </Button>
        )}
        {board.active && (
          <>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="plus" size={18} />}
              onClick={() => openCase(undefined)}
            >
              {t('projectTests.addCase')}
            </Button>
            {/* История кейсов — из git проекта: своего версионирования здесь
                нет намеренно, файлы лежат в репозитории. */}
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="history" size={18} />}
              title={t('projectTests.history.open')}
              onClick={() => setHistoryOpen(true)}
            >
              <span className={styles.narrowLabel}>{t('projectTests.history.open')}</span>
            </Button>
            {/* Обмен — рядом с историей: и то, и другое про связь набора с
                внешним миром, а не про правку кейсов. */}
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="swap" size={18} />}
              onClick={() => setExchangeOpen(true)}
            >
              {t('tests.exchange.open')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="edit" size={18} />}
              title={t('projectTests.editGroup')}
              onClick={() => setGroupEditing(true)}
            >
              <span className={styles.narrowLabel}>{t('projectTests.editGroup')}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="trash" size={18} />}
              title={t('projectTests.removeGroup')}
              onClick={() => setGroupRemoving(true)}
            >
              <span className={styles.narrowLabel}>{t('projectTests.removeGroup')}</span>
            </Button>
          </>
        )}
        {actions}
      </Stack>

      {board.groups.length === 0 &&
        !board.isLoading &&
        (empty ?? (
          <EmptyState
            icon="check"
            title={t('projectTests.empty')}
            text={t('projectTests.emptyHint')}
          />
        ))}

      {board.active && !board.active.error && (
        <>
          <TestFilterBar
            filters={board.filters}
            views={board.views}
            onSaveView={board.saveView}
            onRemoveView={board.removeView}
            onPickBudget={board.pickBudget}
            budget={board.budget}
          />

          <TestBulkToolbar
            checked={board.checked}
            groupId={board.activeId}
            groups={board.groups}
            sections={board.filters.facets.sections}
            onApply={board.bulk}
            onClear={board.clearChecked}
          />
        </>
      )}

      {/* Левая колонка видна и при сломанной группе: причина стоит справа, а
          соседние группы должны оставаться в одном нажатии. */}
      {board.groups.length > 0 && (
        <div className={styles.libraryBody}>
          <aside className={styles.tree}>
            <TestGroupList
              groups={board.groups}
              activeId={board.activeId}
              onSelect={board.select}
              onAdd={() => setGroupOpen(true)}
            />
            {board.active && !board.active.error && (
              <TestSectionTree
                sections={board.filters.sections}
                total={board.filters.total}
                selected={selectedSection}
                onSelect={(path) => board.filters.patch({ sections: path ? [path] : undefined })}
              />
            )}
          </aside>

          <div className={styles.tableArea}>
            {board.active?.error ? (
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body" color="danger">
                  {t('projectTests.broken', { error: serverFieldText(board.active, 'error') })}
                </Typography>
                <Typography variant="caption" color="subtle">
                  {t('projectTests.brokenHint')}
                </Typography>
              </Stack>
            ) : (
              <TestCaseTable
                rows={board.filters.filtered}
                total={board.filters.total}
                checked={board.checked}
                onToggle={board.toggleCase}
                onCheckAll={board.checkAll}
                onClearChecked={board.clearChecked}
                attributes={board.schema.attributes}
                // Счёт риска показывается только там, где его спросили
                // порядком: в обычном списке это лишняя колонка цифр.
                risk={board.filters.sort === 'risk' ? board.filters.risk : undefined}
                flaky={flaky}
                onEdit={(testCase, groupId) => openCase(testCase, groupId)}
                onRemove={(testCase) => setRemoving(testCase)}
              />
            )}
          </div>
        </div>
      )}

      <TestCaseEditor
        isOpen={isCaseOpen}
        onOpenChange={setCaseOpen}
        testCase={editing}
        projectPath={board.path}
        runStamp={runStamp}
        groupId={editingGroupId}
        sharedSteps={board.sharedSteps}
        schema={board.schema}
        sections={board.filters.facets.sections}
        onSave={(input) => board.saveCase(board.activeId, input)}
      />

      <TestExchangeModal
        isOpen={isExchangeOpen}
        onOpenChange={setExchangeOpen}
        path={board.path}
        groupId={board.activeId}
        environments={board.environments}
      />

      <TestHistoryModal
        isOpen={isHistoryOpen}
        onOpenChange={setHistoryOpen}
        projectPath={board.path}
        groupId={board.activeId}
      />

      <TestGroupFormModal
        isOpen={isGroupOpen || isGroupEditing}
        onOpenChange={(open) => {
          if (open) return;
          setGroupOpen(false);
          setGroupEditing(false);
        }}
        groups={board.groups}
        group={isGroupEditing ? board.active : undefined}
        onCreate={board.addGroup}
        onUpdate={board.updateGroup}
      />

      <ConfirmDialog
        isOpen={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={t('projectTests.removeCaseConfirm', { title: removing?.title ?? '' })}
        description={t('projectTests.removeCaseText')}
        confirmLabel={t('common.delete')}
        onConfirm={() => {
          if (removing) board.removeCase(board.activeId, removing.id);
          setRemoving(undefined);
        }}
      />

      <ConfirmDialog
        isOpen={isGroupRemoving}
        onOpenChange={setGroupRemoving}
        title={t('projectTests.removeGroupConfirm', { title: board.active?.title ?? '' })}
        description={t('projectTests.removeGroupText', { file: board.active?.file ?? '' })}
        confirmLabel={t('common.delete')}
        onConfirm={() => {
          if (board.active) board.removeGroup(board.active.id);
          setGroupRemoving(false);
        }}
      />
    </div>
  );
}
