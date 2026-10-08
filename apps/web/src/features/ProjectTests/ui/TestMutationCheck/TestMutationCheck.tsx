import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestMutationMode } from '@agentdeck/contracts';
import {
  useMutationCheck,
  useStartMutationCheck,
  useStopMutationCheck,
} from '@entities/ProjectTest';
import { serverMessageText } from '@shared/config/i18n/server-message';
import { Button } from '@shared/ui/button';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { mutationVerdict } from '../../model/mutationVerdict';
import type { TestMutationCheckProps } from './TestMutationCheck.types';
import { VERDICT_TONE } from './TestMutationCheck.constants';
import { caseWord } from '../../lib/caseWord';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

/**
 * «Проверка набора поломкой» (решение владельца 30.09): единственный честный
 * ответ на «а поймают ли кейсы регрессию». Файл ломается в отдельной копии,
 * привязанные к нему автокейсы прогоняются, отчёт называет пойманное и
 * пропущенное. Дорого по времени — только по кнопке и с подтверждением.
 */
export function TestMutationCheck({ path, isBusy }: TestMutationCheckProps) {
  const { t } = useTranslation();
  const { data } = useMutationCheck(path);
  const start = useStartMutationCheck(path);
  const stop = useStopMutationCheck(path);
  const [picked, setPicked] = useState('');
  const [mode, setMode] = useState<ProjectTestMutationMode>('break');
  const [isConfirming, setIsConfirming] = useState(false);

  const candidates = data?.candidates ?? [];
  const check = data?.check;
  const file = picked || check?.file || candidates[0]?.file || '';
  const isRunning = check?.status === 'running';
  const failure = start.error ?? stop.error;
  const checkError =
    check?.status === 'error'
      ? (serverMessageText(check.errorCode, { file: check.file, ...check.params }) ??
        check.error ??
        '')
      : '';
  const verdict = check?.status === 'done' ? mutationVerdict(check) : undefined;

  return (
    <Stack gap="var(--spacing-xs)" data-testid="tests-mutation">
      <Typography variant="body" weight="semibold">
        {t('testsE2e.mutation.title')}
      </Typography>
      <Typography variant="caption" color="subtle">
        {t('testsE2e.mutation.hint')}
      </Typography>

      {candidates.length === 0 && !check ? (
        <Typography variant="caption" color="subtle">
          {t('testsE2e.mutation.noCandidates')}
        </Typography>
      ) : (
        <Stack direction="row" gap="var(--spacing-xs)" align="end" wrap>
          <SelectField
            label={t('testsE2e.mutation.file')}
            value={file}
            onChange={setPicked}
            options={candidates.map((item) => ({
              value: item.file,
              label: `${item.file} (${item.cases})`,
            }))}
          />
          <SelectField
            label={t('testsE2e.mutation.mode')}
            value={mode}
            onChange={(value) => setMode(value === 'subtle' ? 'subtle' : 'break')}
            options={[
              { value: 'break', label: t('testsE2e.mutation.modeBreak') },
              { value: 'subtle', label: t('testsE2e.mutation.modeSubtle') },
            ]}
          />
          {isRunning ? (
            <Button
              variant="danger"
              size="sm"
              isLoading={stop.isPending}
              onClick={() => stop.mutate()}
            >
              {t('testsE2e.mutation.stop')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={!file || isBusy}
              title={isBusy ? t('testsE2e.run.agentBusy') : undefined}
              onClick={() => setIsConfirming(true)}
            >
              {t('testsE2e.mutation.start')}
            </Button>
          )}
        </Stack>
      )}

      {isRunning && check && (
        <Typography variant="caption" color="subtle" role="status">
          {t(`testsE2e.mutation.stage.${check.stage}`)}
        </Typography>
      )}
      {check?.mutation && (
        <Typography variant="caption" color="subtle">
          {check.file} —{' '}
          {t('testsE2e.mutation.mutation', {
            // Код — на языке окна; строка сервера — запасной путь старой записи.
            what: check.mutationCode
              ? t(`testsE2e.mutation.kind.${check.mutationCode}`, {
                  ...check.mutationParams,
                  interpolation: { escapeValue: false },
                })
              : check.mutation,
            interpolation: { escapeValue: false },
          })}
        </Typography>
      )}
      {check && verdict && (
        <Typography
          variant="caption"
          color={VERDICT_TONE[verdict]}
          data-mutation-caught={check.caught}
          data-mutation-verdict={verdict}
        >
          {t(`testsE2e.mutation.${verdict}`, {
            caught: check.caught,
            count: check.cases.length,
          })}
        </Typography>
      )}
      {check?.cleanupError && (
        <Typography variant="caption" color="warning" role="status">
          {t('testsE2e.mutation.cleanupFailed', { reason: check.cleanupError })}
        </Typography>
      )}
      {check?.status === 'stopped' && (
        <Typography variant="caption" color="subtle">
          {t('testsE2e.mutation.stopped')}
        </Typography>
      )}
      {check?.status === 'done' && (
        <Stack as="ul" gap="var(--spacing-3xs)">
          {check.cases.map((item) => (
            <Typography as="li" variant="caption" key={`${item.groupId}:${item.caseId}`}>
              {item.caseId} · {item.title} — {t(caseWord(item))}
            </Typography>
          ))}
        </Stack>
      )}
      {checkError && (
        <Typography variant="caption" color="danger" role="alert">
          {checkError}
        </Typography>
      )}
      {failure && (
        <Typography variant="caption" color="danger" role="alert">
          {toErrorMessage(failure)}
        </Typography>
      )}
      {check?.log && !isRunning && (
        <details>
          <summary>
            <Typography variant="caption" as="span">
              {t('testsE2e.mutation.log')}
            </Typography>
          </summary>
          <Typography variant="mono" as="pre">
            {check.log.slice(-4000)}
          </Typography>
        </details>
      )}

      <ConfirmDialog
        isOpen={isConfirming}
        onOpenChange={setIsConfirming}
        onConfirm={() => {
          start.reset();
          start.mutate({ file, mode }, { onSettled: () => setIsConfirming(false) });
        }}
        title={t('testsE2e.mutation.confirmTitle')}
        description={t('testsE2e.mutation.confirmText', { file })}
        confirmLabel={t('testsE2e.mutation.confirm')}
        isPending={start.isPending}
      />
    </Stack>
  );
}
