import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import {
  ProjectTestsRunBar,
  TestDraftModal,
  TestLibrary,
  TestsOnboarding,
} from '@features/ProjectTests';
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
  // Какой черновик открыт в приёмке. Пусто — окно закрыто; открывается только
  // по нажатию: непринятое предложение не должно перекрывать библиотеку само.
  const [draftRunId, setDraftRunId] = useState('');
  const pending = board.pendingDraft;
  const lastApplied = board.drafts.find((item) => item.status === 'applied');

  return (
    <div className={styles.libraryTab}>
      {/* Плашка вместо модалки: генерация идёт минутами, и человек возвращается
          во вкладку, чтобы увидеть предложенное, — но выбор момента остаётся
          за ним. Откат тоже отсюда: он нужен ровно тем, кто уже принял. */}
      {(pending ?? lastApplied) && (
        <Stack
          direction="row"
          gap="var(--spacing-xs)"
          align="center"
          wrap
          className={styles.draftBanner}
        >
          <Icon name="plus" size={18} />
          <Typography variant="body" as="span">
            {pending
              ? t('tests.drafts.waiting', { count: pending.pending })
              : t('tests.drafts.doneBanner', { count: lastApplied?.accepted ?? 0 })}
          </Typography>
          <Button
            variant={pending ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setDraftRunId((pending ?? lastApplied)?.runId ?? '')}
          >
            {pending ? t('tests.drafts.open') : t('tests.drafts.openApplied')}
          </Button>
        </Stack>
      )}

      <TestDraftModal
        isOpen={Boolean(draftRunId)}
        onOpenChange={(open) => setDraftRunId(open ? draftRunId : '')}
        projectPath={board.path}
        runId={draftRunId || undefined}
      />

      <ProjectTestsRunBar
        board={board}
        scope={scope}
        onScopeChange={onScopeChange}
        environmentId={environmentId}
        onEnvironmentChange={onEnvironmentChange}
      />

      <TestLibrary
        board={board}
        // Пустой проект встречают три шага, а не общая заглушка: с ними
        // человек уходит отсюда с кейсами, а не с вопросом «и что теперь».
        empty={<TestsOnboarding board={board} scope={scope} environmentId={environmentId} />}
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
