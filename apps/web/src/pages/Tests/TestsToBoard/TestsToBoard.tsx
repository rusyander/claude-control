import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestPointResult } from '@agentdeck/contracts';
import { boardMoveRefusalOf, newUuidv7, useCoreBoard } from '@entities/CoreTask';
import { toLanguage } from '@shared/config/i18n';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { caseOnBoard, testsEntryDraft, testsEntryKey } from './testsToBoard.lib';
import { useTestsToBoard } from './testsToBoardApi';

const P = 'coreInbox.tests';

interface TestsToBoardProps {
  projectPath: string;
  runId: string;
  title: string;
  result: ProjectTestPointResult;
}

/**
 * «На доску» у красного кейса (этап 12, I7): провал ложится записью во «Входящие» доски ядра —
 * пресет «исправить дефект», источник `tests`, текст провала из записи прогона. Принято ядром или
 * открытая карточка кейса уже на доске — кнопка «На доске» и заперта; отказ — причина ядра рядом,
 * повтор — новым ходом.
 */
export function TestsToBoard({ projectPath, runId, title, result }: TestsToBoardProps) {
  const { t, i18n } = useTranslation();
  const entries = useTestsToBoard();
  const board = useCoreBoard();
  const [cmdId, setCmdId] = useState(newUuidv7);
  const entryKey = testsEntryKey(result.groupId, result.caseId);
  // Принято сейчас — или открытая карточка кейса уже на доске: записи ядро по кейсу не склеит.
  const done = entries.isSuccess || caseOnBoard(board.data?.cards, entryKey);
  const key = `${result.groupId}:${result.caseId}`;

  const send = () => {
    const draft = testsEntryDraft(
      { projectPath, runId, title, result, lang: toLanguage(i18n.language) },
      (k, values) => t(`${P}.${k}`, values),
    );
    entries.mutate(
      { to: 'inbox', entries: [draft], cmdId },
      {
        // Ядро ответило отказом — следующий ход новый; обрыв связи — тот же ключ, без второй записи.
        onError: (error) => {
          if (boardMoveRefusalOf(error).status !== undefined) setCmdId(newUuidv7());
        },
      },
    );
  };

  return (
    <Stack direction="row" gap="var(--spacing-3xs)" align="center" wrap>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={<Icon name={done ? 'check' : 'layers'} size={16} />}
        disabled={done || entries.isPending}
        isLoading={entries.isPending}
        title={t(`${P}.toBoardHint`)}
        onClick={send}
        data-tests-to-board={key}
        data-tests-to-board-state={done ? 'done' : undefined}
        data-tests-entry-key={entryKey}
      >
        {done ? t(`${P}.onBoard`) : t(`${P}.toBoard`)}
      </Button>
      {entries.isError && (
        <Typography
          variant="caption"
          color="danger"
          as="span"
          role="alert"
          data-tests-to-board-error
        >
          {t(`${P}.failed`, { reason: boardMoveRefusalOf(entries.error).reason })}
        </Typography>
      )}
    </Stack>
  );
}
