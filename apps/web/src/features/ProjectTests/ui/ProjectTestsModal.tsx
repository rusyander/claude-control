import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { useTestsBoard } from '../model/useTestsBoard';
import { TestLibrary } from './TestLibrary';
import { ProjectTestsRunBar } from './ProjectTestsRunBar';
import type { ProjectTestsModalProps } from './ProjectTestsModal.types';
import styles from './ProjectTests.module.scss';

/**
 * Окно тест-кейсов из чата — тонкая обёртка над библиотекой.
 *
 * Раздел «Тестирование» и это окно показывают ОДИН И ТОТ ЖЕ блок: у окна
 * остались только рамка и пульт прогона. Своей копии списка здесь нет намеренно
 * — две реализации библиотеки разошлись бы молча, и человек видел бы разные
 * наборы кейсов в зависимости от того, откуда открыл.
 */
export function ProjectTestsModal({ isOpen, onOpenChange, projectPath }: ProjectTestsModalProps) {
  const { t } = useTranslation();
  const board = useTestsBoard(projectPath, isOpen);
  const [scope, setScope] = useState('');

  return (
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
        <div className={styles.list}>
          <TestLibrary board={board} />
        </div>
      </div>
    </Modal>
  );
}
