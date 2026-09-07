import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { ProjectTestsRunBar, TestLibrary } from '@features/ProjectTests';
import type { TestsLibraryTabProps } from './TestsLibraryTab.types';
import styles from './TestsPage.module.scss';

/**
 * Вкладка «Библиотека»: пульт прогона и сама библиотека кейсов.
 *
 * Кнопка ручного прохода живёт в ряду действий библиотеки, а не в пульте
 * прогона: пульт — про то, что запускает АГЕНТ, и смешивать в нём «запусти
 * агента» с «я пойду сам» значит каждый раз перечитывать подписи, чтобы не
 * запустить не то.
 */
export function TestsLibraryTab({
  board,
  scope,
  onScopeChange,
  environmentId,
  onEnvironmentChange,
  onStartManual,
  isStartingManual,
}: TestsLibraryTabProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.libraryTab}>
      <ProjectTestsRunBar
        board={board}
        scope={scope}
        onScopeChange={onScopeChange}
        environmentId={environmentId}
        onEnvironmentChange={onEnvironmentChange}
      />

      <TestLibrary
        board={board}
        actions={
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Icon name="check" size={18} />}
            isLoading={isStartingManual}
            disabled={board.filters.filtered.length === 0}
            onClick={onStartManual}
          >
            {board.checked.length > 0
              ? t('tests.runner.startSelected', { count: board.checked.length })
              : t('tests.runner.start')}
          </Button>
        }
      />
    </div>
  );
}
