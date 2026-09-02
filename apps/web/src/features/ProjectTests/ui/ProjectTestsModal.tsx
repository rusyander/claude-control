import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestCase } from '@claude-control/contracts';
import { Modal } from '@shared/ui/modal';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TabButton } from '@shared/ui/tab-button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { EmptyState } from '@shared/ui/empty-state';
import { toErrorMessage } from '@shared/api/client';
import { useTestsBoard } from '../model/useTestsBoard';
import { ProjectTestRow } from './ProjectTestRow';
import { ProjectTestCaseDialog } from './ProjectTestCaseDialog';
import { ProjectTestsRunBar } from './ProjectTestsRunBar';
import type { ProjectTestsModalProps } from './ProjectTestsModal.types';
import styles from './ProjectTests.module.scss';

/**
 * Окно тест-кейсов проекта: вкладки-группы, список кейсов и пульт прогона.
 *
 * Группа — это файл в `.agent/tests/`, поэтому вкладки не настраиваются в
 * панели: завёл файл — появилась вкладка, и завести его может как человек
 * кнопкой, так и агент во время генерации. Второго списка групп, который надо
 * держать в согласии с файлами, здесь нет намеренно.
 */
export function ProjectTestsModal({ isOpen, onOpenChange, projectPath }: ProjectTestsModalProps) {
  const { t } = useTranslation();
  const board = useTestsBoard(projectPath, isOpen);

  const [scope, setScope] = useState('');
  const [isGroupOpen, setGroupOpen] = useState(false);
  const [groupId, setGroupId] = useState('');
  const [groupError, setGroupError] = useState<string | undefined>();
  const [editing, setEditing] = useState<ProjectTestCase | undefined>();
  const [isCaseOpen, setCaseOpen] = useState(false);
  const [removingCase, setRemovingCase] = useState<ProjectTestCase | undefined>();
  const [isGroupRemoving, setGroupRemoving] = useState(false);

  const openCase = (testCase?: ProjectTestCase): void => {
    setEditing(testCase);
    setCaseOpen(true);
  };

  const addGroup = async (): Promise<void> => {
    setGroupError(undefined);
    try {
      await board.addGroup(groupId.trim().toLowerCase());
    } catch (error) {
      // Причина — под полем, а не только в тосте за модалкой: раньше отказ
      // (400 на негодный id) уходил необработанным отклонением промиса.
      setGroupError(toErrorMessage(error));
      return;
    }
    setGroupId('');
    setGroupOpen(false);
  };

  const cases = board.active?.cases ?? [];

  return (
    <>
      <Modal
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        title={t('projectTests.title')}
        description={t('projectTests.description', { dir: board.dir })}
        size="full"
        bodyFill
      >
        <div className={styles.layout}>
          <ProjectTestsRunBar board={board} scope={scope} onScopeChange={setScope} />

          <Stack direction="row" gap="var(--spacing-2xs)" align="center" className={styles.tabs}>
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
                <Button variant="ghost" size="sm" onClick={board.checkAll}>
                  {t('projectTests.selectAll')}
                </Button>
                {board.checked.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={board.clearChecked}>
                    {t('projectTests.clearSelection')}
                  </Button>
                )}
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
          </Stack>

          <div className={styles.list}>
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

            {board.active && cases.length === 0 && !board.active.error && (
              <Typography variant="caption" color="subtle">
                {t('projectTests.emptyGroup')}
              </Typography>
            )}

            {cases.map((testCase) => (
              <ProjectTestRow
                key={testCase.id}
                testCase={testCase}
                isChecked={board.checked.includes(testCase.id)}
                onCheck={() => board.toggleCase(testCase.id)}
                onEdit={() => openCase(testCase)}
                onRemove={() => setRemovingCase(testCase)}
              />
            ))}
          </div>
        </div>
      </Modal>

      <ProjectTestCaseDialog
        isOpen={isCaseOpen}
        onOpenChange={setCaseOpen}
        testCase={editing}
        onSave={(input) => board.saveCase(board.activeId, input)}
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
        isOpen={removingCase !== undefined}
        onOpenChange={(open) => !open && setRemovingCase(undefined)}
        title={t('projectTests.removeCaseConfirm', { title: removingCase?.title ?? '' })}
        description={t('projectTests.removeCaseText')}
        confirmLabel={t('common.delete')}
        onConfirm={() => {
          if (removingCase) board.removeCase(board.activeId, removingCase.id);
          setRemovingCase(undefined);
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
    </>
  );
}
