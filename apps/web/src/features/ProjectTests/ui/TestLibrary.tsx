import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestCase } from '@agentdeck/contracts';
import { useEntityUrl } from '@shared/hooks/use-entity-url';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TabButton } from '@shared/ui/tab-button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { Modal } from '@shared/ui/modal';
import { EmptyState } from '@shared/ui/empty-state';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { toErrorMessage } from '@shared/api/client';
import { TestFilterBar } from './TestFilterBar';
import { TestSectionTree } from './TestSectionTree';
import { TestCaseTable } from './TestCaseTable';
import { TestBulkToolbar } from './TestBulkToolbar';
import { TestCaseEditor } from './TestCaseEditor';
import { TestHistoryModal } from './TestHistoryModal';
import { TestExchangeModal } from './TestExchangeModal';
import type { TestLibraryProps } from './TestLibrary.types';
import styles from './ProjectTests.module.scss';

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
export function TestLibrary({ board, actions }: TestLibraryProps) {
  const { t } = useTranslation();
  const [isGroupOpen, setGroupOpen] = useState(false);
  const [groupId, setGroupId] = useState('');
  const [groupError, setGroupError] = useState<string | undefined>();
  const [isGroupRemoving, setGroupRemoving] = useState(false);
  const [editing, setEditing] = useState<ProjectTestCase | undefined>();
  const [isCaseOpen, setCaseOpen] = useState(false);
  const [removing, setRemoving] = useState<ProjectTestCase | undefined>();
  const [isHistoryOpen, setHistoryOpen] = useState(false);
  const [isExchangeOpen, setExchangeOpen] = useState(false);

  const addGroup = async (): Promise<void> => {
    setGroupError(undefined);
    try {
      await board.addGroup(groupId.trim().toLowerCase());
    } catch (error) {
      // Причина — под полем, а не только в тосте за окном: отказ (400 на
      // негодный id) иначе уходит необработанным отклонением промиса.
      setGroupError(toErrorMessage(error));
      return;
    }
    setGroupId('');
    setGroupOpen(false);
  };

  const openCase = (testCase?: ProjectTestCase): void => {
    setEditing(testCase);
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
      openCase(item.testCase);
    },
  });

  const selectedSection = board.filters.filter.sections?.[0] ?? '';

  return (
    <div className={styles.library}>
      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap className={styles.tabs}>
        {board.groups.map((group) => (
          <TabButton
            key={group.id}
            isActive={group.id === board.activeId}
            onClick={() => board.select(group.id)}
          >
            {`${group.title} (${group.cases.length})`}
          </TabButton>
        ))}
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Icon name="plus" size={18} />}
          onClick={() => setGroupOpen(true)}
        >
          {t('projectTests.addGroup')}
        </Button>
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
              onClick={() => setHistoryOpen(true)}
            >
              {t('projectTests.history.open')}
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
              leftIcon={<Icon name="trash" size={18} />}
              onClick={() => setGroupRemoving(true)}
            >
              {t('projectTests.removeGroup')}
            </Button>
          </>
        )}
        {actions}
      </Stack>

      {board.active?.error && (
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" color="danger">
            {t('projectTests.broken', { error: board.active.error })}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('projectTests.brokenHint')}
          </Typography>
        </Stack>
      )}

      {board.groups.length === 0 && !board.isLoading && (
        <EmptyState
          icon="check"
          title={t('projectTests.empty')}
          text={t('projectTests.emptyHint')}
        />
      )}

      {board.active && !board.active.error && (
        <>
          <TestFilterBar
            filters={board.filters}
            views={board.views}
            onSaveView={board.saveView}
            onRemoveView={board.removeView}
          />

          <TestBulkToolbar
            checked={board.checked}
            groupId={board.activeId}
            groups={board.groups}
            sections={board.filters.facets.sections}
            onApply={board.bulk}
            onClear={board.clearChecked}
          />

          <div className={styles.libraryBody}>
            <aside className={styles.tree}>
              <TestSectionTree
                sections={board.filters.sections}
                total={board.filters.total}
                selected={selectedSection}
                onSelect={(path) => board.filters.patch({ sections: path ? [path] : undefined })}
              />
            </aside>

            <div className={styles.tableArea}>
              <TestCaseTable
                rows={board.filters.filtered}
                total={board.filters.total}
                checked={board.checked}
                onToggle={board.toggleCase}
                onCheckAll={board.checkAll}
                onClearChecked={board.clearChecked}
                attributes={board.schema.attributes}
                onEdit={(testCase) => openCase(testCase)}
                onRemove={(testCase) => setRemoving(testCase)}
              />
            </div>
          </div>
        </>
      )}

      <TestCaseEditor
        isOpen={isCaseOpen}
        onOpenChange={setCaseOpen}
        testCase={editing}
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

      <Modal
        isOpen={isGroupOpen}
        onOpenChange={setGroupOpen}
        title={t('projectTests.addGroup')}
        size="sm"
        footer={
          <Stack direction="row" gap="var(--spacing-xs)" justify="end">
            <Button variant="ghost" onClick={() => setGroupOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={groupId.trim().length === 0}
              onClick={() => void addGroup()}
            >
              {t('projectTests.save')}
            </Button>
          </Stack>
        }
      >
        <TextField
          label={t('projectTests.groupId')}
          hint={t('projectTests.groupIdHint')}
          value={groupId}
          onChange={(next) => {
            setGroupId(next);
            setGroupError(undefined);
          }}
          error={groupError}
          autoFocus
          isMono
        />
      </Modal>

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
