import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { CORE_TASKS_ROUTE } from '@shared/config/routes';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import { toErrorMessage } from '@shared/api/toErrorMessage';
import { keptWalk, useRecordWalk, useStartWalk, useWalkRows } from './recordedApi';
import styles from './TestsRecordedTab.module.scss';
import type { RecordWalkModalProps } from './TestsRecordedTab.types';

/** Группа, куда ложатся сценарии, если человек не выбрал другую. */
const DEFAULT_GROUP = 'scenarios';

/**
 * «Записать сценарий» — три шага в одном окне: цель словами → проход ядра (строки приходят по
 * мере хода, окно показывает счёт) → имя и группа → кейс и спек. Спек собирает сервер чистой
 * функцией строк прохода; здесь только то, что человек решает: что пройти, как назвать, куда
 * положить. Проход без единого удавшегося шага записать нельзя — кнопки нет, причина словами.
 */
export function RecordWalkModal({
  isOpen,
  onOpenChange,
  projectPath,
  environments,
  groups,
}: RecordWalkModalProps) {
  const { t, i18n } = useTranslation();
  const [goal, setGoal] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [title, setTitle] = useState('');
  const [groupId, setGroupId] = useState(DEFAULT_GROUP);
  const start = useStartWalk(projectPath);
  const record = useRecordWalk(projectPath);
  // Проход — платная задача ядра: закрытое окно или перечитанная страница его не теряют, пока он
  // не записан в кейс или человек не начал новый (`keptWalk`, своя на проект и вкладку браузера).
  const [kept, setKept] = useState(() => keptWalk.read(projectPath));
  useEffect(() => setKept(keptWalk.read(projectPath)), [projectPath]);
  const started = start.data?.taskId;
  useEffect(() => {
    if (started) keptWalk.write(projectPath, started);
  }, [projectPath, started]);
  const taskId = started ?? kept;
  const walk = useWalkRows(taskId);
  const rows = walk.data;
  const passed = rows?.steps.filter((step) => step.ok).length ?? 0;
  // Записывать нечего: кейс уже записан или проход кончился без удавшегося шага.
  const spent = Boolean(record.data) || (Boolean(rows?.ended) && passed === 0);

  const discard = () => {
    keptWalk.write(projectPath, undefined);
    setKept(undefined);
    setGoal('');
    setTitle('');
    start.reset();
    record.reset();
  };
  const close = () => {
    onOpenChange(false);
    if (!taskId || spent) discard();
  };

  const groupOptions = [
    ...(groups.some((group) => group.id === DEFAULT_GROUP)
      ? []
      : [{ value: DEFAULT_GROUP, label: DEFAULT_GROUP }]),
    ...groups.map((group) => ({ value: group.id, label: group.title })),
  ];
  const environmentOptions = [
    { value: '', label: t('testsRecorded.replayDefault') },
    ...environments.map((item) => ({ value: item.id, label: item.title })),
  ];

  const footer = (
    <Stack direction="row" gap="var(--spacing-xs)" justify="end">
      <Button variant="ghost" onClick={close}>
        {t(record.data ? 'testsRecorded.modal.close' : 'testsRecorded.modal.cancel')}
      </Button>
      {taskId && !spent && (
        <Button variant="secondary" onClick={discard} title={t('testsRecorded.modal.newWalkHint')}>
          {t('testsRecorded.modal.newWalk')}
        </Button>
      )}
      {!taskId && (
        <Button
          variant="primary"
          isLoading={start.isPending}
          disabled={!goal.trim() || start.isPending}
          onClick={() =>
            start.mutate({
              goal: goal.trim(),
              ...(environmentId ? { environmentId } : {}),
              lang: i18n.language.startsWith('en') ? 'en' : 'ru',
            })
          }
        >
          {t(start.isPending ? 'testsRecorded.modal.starting' : 'testsRecorded.modal.start')}
        </Button>
      )}
      {taskId && rows?.ended && passed > 0 && !record.data && (
        <Button
          variant="primary"
          isLoading={record.isPending}
          disabled={!title.trim() || record.isPending}
          onClick={() =>
            record.mutate({
              groupId,
              title: title.trim(),
              taskId,
              steps: rows.steps,
              gaps: rows.gaps,
            })
          }
        >
          {t('testsRecorded.modal.save')}
        </Button>
      )}
    </Stack>
  );

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={t('testsRecorded.modal.title')}
      size="md"
      footer={footer}
    >
      <Stack gap="var(--spacing-sm)">
        {!taskId && (
          <>
            <TextField
              label={t('testsRecorded.modal.goal')}
              value={goal}
              onChange={setGoal}
              hint={t('testsRecorded.modal.goalHint')}
              multiline
              rows={3}
              autoFocus
            />
            <SelectField
              label={t('testsRecorded.modal.environment')}
              value={environmentId}
              onChange={setEnvironmentId}
              options={environmentOptions}
            />
          </>
        )}
        {taskId && !rows?.ended && (
          <Stack gap="var(--spacing-2xs)" role="status">
            <Typography variant="body">
              {t('testsRecorded.modal.walking', {
                steps: rows?.steps.length ?? 0,
                gaps: rows?.gaps.length ?? 0,
              })}
            </Typography>
            <Typography variant="caption" color="muted">
              {t('testsRecorded.modal.walkingHint')}
            </Typography>
          </Stack>
        )}
        {rows?.ended && (
          <Typography variant="body" role="status">
            {t('testsRecorded.modal.ended', {
              steps: rows.steps.length,
              passed,
              gaps: rows.gaps.length,
            })}
          </Typography>
        )}
        {rows?.ended && passed === 0 && (
          <Typography variant="body-sm" color="warning" role="alert">
            {t('testsRecorded.modal.noPassed')}
          </Typography>
        )}
        {taskId && (
          <Link to={CORE_TASKS_ROUTE} search={{ id: taskId } as never} className={styles.taskLink}>
            {t('testsRecorded.modal.openTask')}
          </Link>
        )}
        {rows?.ended && passed > 0 && !record.data && (
          <>
            <TextField
              label={t('testsRecorded.modal.caseTitle')}
              value={title}
              onChange={setTitle}
              autoFocus
            />
            <SelectField
              label={t('testsRecorded.modal.group')}
              value={groupId}
              onChange={setGroupId}
              options={groupOptions}
            />
          </>
        )}
        {record.data && (
          <Stack gap="var(--spacing-2xs)" role="status">
            <Typography variant="body" color="success">
              {t('testsRecorded.modal.saved', { file: record.data.file })}
            </Typography>
            {record.data.unchecked > 0 && (
              <Typography variant="body-sm" color="warning">
                {t('testsRecorded.modal.unchecked', { count: record.data.unchecked })}
              </Typography>
            )}
          </Stack>
        )}
        {[start, record, walk].map((item, index) =>
          item.isError ? (
            <Typography key={index} variant="body-sm" color="danger" role="alert">
              {toErrorMessage(item.error)}
            </Typography>
          ) : null,
        )}
      </Stack>
    </Modal>
  );
}
