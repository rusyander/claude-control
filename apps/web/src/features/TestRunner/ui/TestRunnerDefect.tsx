import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestDefectDraft } from '@agentdeck/contracts';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { toErrorMessage } from '@shared/api/client';
import { useCreateTestDefect, useTestDefectDraft } from '@entities/ProjectTest';
import type { TestRunnerDefectProps } from './TestRunnerDefect.types';

/**
 * Дефект по провалу.
 *
 * Черновик собирает СЕРВЕР — из шагов кейса, ожидания, заметки о том, что
 * увидели, и хвоста лога: человек в этот момент помнит только «не работает», а
 * повторимость баг-репорта решается тем, что в нём есть шаги. Править черновик
 * можно, и заведение всё равно требует явного нажатия: `gh`/`glab` пишут в
 * чужой трекер.
 */
export function TestRunnerDefect({
  isOpen,
  onOpenChange,
  projectPath,
  groupId,
  caseId,
  runId,
}: TestRunnerDefectProps) {
  const { t } = useTranslation();
  const build = useTestDefectDraft(projectPath);
  const create = useCreateTestDefect(projectPath);

  const [draft, setDraft] = useState<ProjectTestDefectDraft | undefined>();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [url, setUrl] = useState<string | undefined>();

  // Черновик просится при открытии: собирать его заранее для каждого кейса
  // списка значит гонять сервер ради текста, который никто не откроет.
  useEffect(() => {
    if (!isOpen || !caseId) return;
    setError(undefined);
    setUrl(undefined);
    build
      .mutateAsync({ groupId, caseId, runId })
      .then((next) => {
        setDraft(next);
        setTitle(next.title);
        setBody(next.body);
        setTarget(next.targets[0] ?? '');
      })
      .catch((cause: unknown) => setError(toErrorMessage(cause)));
    // Пересобирать черновик на каждый рендер незачем — только на открытие кейса.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, groupId, caseId, runId]);

  const submit = async (): Promise<void> => {
    setError(undefined);
    try {
      const created = await create.mutateAsync({ groupId, caseId, target, title, body });
      setUrl(created);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('tests.runner.defect')}
      description={draft?.hint}
      size="lg"
      footer={
        <Stack direction="row" gap="var(--spacing-xs)" justify="end" align="center">
          {error && (
            <Typography variant="caption" color="danger" as="span">
              {error}
            </Typography>
          )}
          {/* Черновик — всегда доступная цель: трекера может не быть вовсе, а
              описание провала, собранное сервером, нужно в любом случае. */}
          <Button
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(`${title}\n\n${body}`)}
            disabled={!body}
          >
            {t('tests.runner.defectCopy')}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            isLoading={create.isPending}
            disabled={!target || !title.trim() || Boolean(url)}
            onClick={() => void submit()}
          >
            {t('tests.runner.defectCreate')}
          </Button>
        </Stack>
      }
    >
      <Stack gap="var(--spacing-sm)">
        {build.isPending && (
          <Typography variant="caption" color="subtle">
            {t('tests.runner.defectBuilding')}
          </Typography>
        )}

        {url && (
          <Typography variant="body-sm" color="success">
            {t('tests.runner.defectCreated', { url })}
          </Typography>
        )}

        {draft && draft.targets.length === 0 && (
          <Typography variant="caption" color="warning">
            {t('tests.runner.defectNoTargets')}
          </Typography>
        )}

        {draft && draft.targets.length > 0 && (
          <SelectField
            label={t('tests.runner.defectTarget')}
            value={target}
            onChange={setTarget}
            hint={t('tests.runner.defectTargetHint')}
            // Список целей приходит с сервера и растёт вместе с ним (Jira,
            // фордж по токену). Незнакомую подписываем её собственным именем —
            // это честнее, чем спрятать её или соврать чужим ярлыком.
            options={draft.targets.map((item) => ({
              value: item,
              label: t(`tests.runner.defectTargetName.${item}`, { defaultValue: item }),
            }))}
          />
        )}

        <TextField label={t('tests.runner.defectTitle')} value={title} onChange={setTitle} />
        <TextField
          label={t('tests.runner.defectBody')}
          value={body}
          onChange={setBody}
          multiline
          rows={14}
          isMono
        />
      </Stack>
    </Modal>
  );
}
