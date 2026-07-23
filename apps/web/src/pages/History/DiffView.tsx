import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiffLineKind } from '@claude-control/contracts';
import { Typography } from '@shared/ui/typography';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { useHistoryDiff, useRevertHunk } from '@entities/History';
import type { DiffViewProps } from './DiffView.types';
import styles from './HistoryPage.module.scss';

/** Префикс строки диффа по её типу: как в unified diff. */
const PREFIX: Record<DiffLineKind, string> = { add: '+', del: '-', ctx: ' ' };

/**
 * Полный построчный дифф одной копии. Грузится лениво — только когда запись
 * ленты раскрыта. Добавленные и удалённые строки подсвечены токенами
 * success/danger и выведены моноширинно.
 *
 * У самой свежей копии (её дифф — против ТЕКУЩЕГО файла на диске) каждый ханк
 * можно вернуть по отдельности: кнопка на первой строке блока откатывает
 * ровно его к состоянию копии, не трогая остального файла. У копий, сравнённых
 * с предыдущей копией (а не с текущим файлом), выборочный откат не предлагаем:
 * его блоки не ложатся однозначно на нынешний файл — там доступен откат целиком
 * на странице настроек.
 */
export function DiffView({ name }: DiffViewProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useHistoryDiff(name);
  const revert = useRevertHunk();
  const [pendingHunk, setPendingHunk] = useState<number | undefined>(undefined);

  if (isLoading) {
    return (
      <Typography variant="body-sm" color="subtle">
        {t('history.loadingDiff')}
      </Typography>
    );
  }

  if (isError || !data) {
    return (
      <Typography variant="body-sm" color="danger">
        {t('history.diffError')}
      </Typography>
    );
  }

  // Дифф не показывается: первая версия, бинарный или слишком большой файл.
  if (data.skipped) {
    return (
      <Typography variant="body-sm" color="subtle">
        {t(`history.skip_${data.reason ?? 'initial'}`)}
      </Typography>
    );
  }

  // Выборочный откат — только когда дифф считался против текущего файла.
  const canRevert = data.label === 'current';

  return (
    <>
      <div className={styles.diff} aria-label={t('history.diffLabel', { file: data.file })}>
        {data.lines.map((line, index) => {
          // Первая строка ханка — та, у которой номер ханка появился впервые
          // (у предыдущей строки его не было или он был другим).
          const isHunkStart = line.hunk !== undefined && data.lines[index - 1]?.hunk !== line.hunk;

          return (
            <div
              // Строки диффа не имеют собственного идентификатора; индекс здесь
              // устойчив — список статичен и не переупорядочивается.
              key={index}
              className={styles.diffLine}
              data-kind={line.kind}
            >
              <span className={styles.diffSign}>{PREFIX[line.kind]}</span>
              <span className={styles.diffText}>{line.text}</span>
              {canRevert && isHunkStart && (
                <button
                  type="button"
                  className={styles.revertHunk}
                  onClick={() => setPendingHunk(line.hunk)}
                  disabled={revert.isPending}
                >
                  {t('history.revertHunk')}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Откат пишет в рабочий конфиг — подтверждаем, как и откат целиком. */}
      <ConfirmDialog
        isOpen={pendingHunk !== undefined}
        onOpenChange={(open) => !open && setPendingHunk(undefined)}
        title={t('history.revertHunkConfirmTitle')}
        description={t('history.revertHunkConfirmText', { file: data.file })}
        confirmLabel={t('history.revertHunk')}
        isPending={revert.isPending}
        onConfirm={() => {
          if (pendingHunk !== undefined) revert.mutate({ name, hunk: pendingHunk });
          setPendingHunk(undefined);
        }}
      />
    </>
  );
}
