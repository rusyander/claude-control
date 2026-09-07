import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestStatus } from '@agentdeck/contracts';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { EmptyState } from '@shared/ui/empty-state';
import { percentOf } from '@entities/ProjectTest';
import { formatElapsed, useManualRunner } from '../model/useManualRunner';
import { TestRunnerPoints } from './TestRunnerPoints';
import { TestRunnerDefect } from './TestRunnerDefect';
import type { TestRunnerModalProps } from './TestRunnerModal.types';
import styles from './TestRunner.module.scss';

/** Вердикты прохода в том порядке, в каком их жмут чаще всего. */
const VERDICTS: readonly ProjectTestStatus[] = ['passed', 'failed', 'skipped', 'blocked'];

/**
 * Что кладут в доказательство: снимок экрана и текстовый вывод.
 *
 * Список свой, а не общий с вложениями чата: там он про то, что панель умеет
 * ПОКАЗАТЬ в разговоре, а здесь — про то, чем доказывают провал, и это разные
 * наборы. Одно место на весь раздел, чтобы копии не расходились.
 */
const EVIDENCE_ACCEPT = 'image/*,.log,.txt,.json';

/**
 * Ручной проход: слева список поинтов, справа текущий.
 *
 * Окно во весь экран намеренно: человек в этот момент смотрит В ПРИЛОЖЕНИЕ и
 * возвращается сюда отметить шаг, поэтому всё нужное — шаги, заметка,
 * скриншот, «завести дефект» — должно быть на одном экране без прокрутки к
 * кнопкам. Секундомер идёт с открытия поинта и уходит в результат: без него
 * оценка длительности кейсов остаётся выдуманной навсегда.
 */
export function TestRunnerModal({
  isOpen,
  onOpenChange,
  projectPath,
  groups,
  sharedSteps,
}: TestRunnerModalProps) {
  const { t } = useTranslation();
  const runner = useManualRunner(projectPath, groups, sharedSteps, isOpen);
  const [isDefectOpen, setDefectOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const statusOf = (index: number): ProjectTestStatus =>
    runner.stepResults.find((item) => item.index === index)?.status ?? 'unknown';

  const finish = (): void => {
    runner.finish();
    onOpenChange(false);
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        title={t('tests.runner.title')}
        description={t('tests.runner.subtitle')}
        size="full"
        bodyFill
      >
        {!runner.isActive ? (
          <EmptyState
            icon="check"
            title={t('tests.runner.noSession')}
            text={t('tests.runner.noSessionHint')}
          />
        ) : (
          <div className={styles.layout}>
            <div className={styles.head}>
              <div
                className={styles.progress}
                role="progressbar"
                aria-valuenow={runner.done}
                aria-valuemin={0}
                aria-valuemax={runner.total}
                aria-label={t('tests.runner.progress', {
                  done: runner.done,
                  total: runner.total,
                })}
              >
                <span
                  className={styles.progressFill}
                  style={{ width: `${percentOf(runner.done, runner.total)}%` }}
                />
              </div>
              <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
                {/* Сначала «где я сейчас», потом «сколько закрыто»: человек,
                    идущий по проходам, спрашивает у счётчика именно первое, а
                    полоса рядом уже показывает второе. */}
                <Typography variant="caption" color="subtle" as="span">
                  {t('tests.runner.position', {
                    index: Math.min(runner.index + 1, runner.total),
                    total: runner.total,
                    done: runner.done,
                  })}
                </Typography>
                <Badge tone="info">{formatElapsed(runner.elapsedMs)}</Badge>
                <Button variant="ghost" size="sm" onClick={runner.cancel}>
                  {t('tests.runner.cancel')}
                </Button>
                <Button variant="secondary" size="sm" onClick={finish}>
                  {t('tests.runner.finish')}
                </Button>
              </Stack>
            </div>

            <aside className={styles.side}>
              <TestRunnerPoints
                points={runner.points}
                results={runner.results}
                index={runner.index}
                onSelect={runner.goto}
              />
            </aside>

            <div className={styles.body}>
              <Typography variant="heading-sm">{runner.point?.title ?? ''}</Typography>

              {runner.point?.params && Object.keys(runner.point.params).length > 0 && (
                <Stack direction="row" gap="var(--spacing-2xs)" wrap>
                  {Object.entries(runner.point.params).map(([name, value]) => (
                    <Badge key={name} tone="neutral">{`${name} = ${value}`}</Badge>
                  ))}
                </Stack>
              )}

              {runner.precondition && (
                <Typography variant="body-sm" color="subtle">
                  {t('tests.runner.precondition', { text: runner.precondition })}
                </Typography>
              )}

              <ol className={styles.steps}>
                {runner.steps.map((step, index) => (
                  <li key={index} className={styles.step}>
                    <Stack gap="var(--spacing-3xs)">
                      <Typography variant="body-sm">{step.action}</Typography>
                      {step.data && (
                        <Typography variant="caption" color="subtle">
                          {t('tests.runner.stepData', { text: step.data })}
                        </Typography>
                      )}
                      {step.expected && (
                        <Typography variant="caption" color="subtle">
                          {t('tests.runner.stepExpected', { text: step.expected })}
                        </Typography>
                      )}
                      <Stack direction="row" gap="var(--spacing-3xs)" wrap>
                        {VERDICTS.map((verdict) => (
                          <Button
                            key={verdict}
                            variant={statusOf(index) === verdict ? 'primary' : 'ghost'}
                            size="sm"
                            onClick={() => runner.setStepStatus(index, verdict)}
                          >
                            {t(`projectTests.status.${verdict}`)}
                          </Button>
                        ))}
                      </Stack>
                      <TextField
                        label={t('tests.runner.stepNote', { index: index + 1 })}
                        value={runner.stepResults.find((item) => item.index === index)?.note ?? ''}
                        onChange={(value) => runner.setStepNote(index, value)}
                      />
                    </Stack>
                  </li>
                ))}
              </ol>

              {runner.expected && (
                <Typography variant="body-sm" color="subtle">
                  {t('tests.runner.expected', { text: runner.expected })}
                </Typography>
              )}

              <TextField
                label={t('tests.runner.note')}
                hint={t('tests.runner.noteHint')}
                value={runner.note}
                onChange={runner.setNote}
                multiline
                rows={3}
              />

              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                {/* Нативный input скрыт, а нажимают по кнопке: системный
                    «Выберите файл» не переводится и ломает строку действий. */}
                <input
                  ref={fileInput}
                  type="file"
                  accept={EVIDENCE_ACCEPT}
                  className={styles.file}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void runner.attach(file);
                    event.target.value = '';
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<Icon name="paperclip" size={16} />}
                  isLoading={runner.isAttaching}
                  onClick={() => fileInput.current?.click()}
                >
                  {t('tests.runner.attach')}
                </Button>
                {runner.attachments.map((file) => (
                  <Badge key={file} tone="neutral">
                    {file}
                  </Badge>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Icon name="warning" size={16} />}
                  disabled={!runner.current}
                  onClick={() => setDefectOpen(true)}
                >
                  {t('tests.runner.defect')}
                </Button>
              </Stack>

              <div className={styles.verdicts}>
                <Button
                  variant="ghost"
                  leftIcon={<Icon name="chevronLeft" size={18} />}
                  disabled={runner.index === 0}
                  onClick={() => runner.goto(runner.index - 1)}
                >
                  {t('tests.runner.prev')}
                </Button>
                {VERDICTS.map((verdict) => (
                  <Button
                    key={verdict}
                    variant={verdict === 'passed' ? 'primary' : 'secondary'}
                    isLoading={runner.isBusy}
                    onClick={() => void runner.submit(verdict)}
                  >
                    {t(`tests.runner.verdict.${verdict}`)}
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  rightIcon={<Icon name="chevronRight" size={18} />}
                  disabled={runner.index >= runner.total - 1}
                  onClick={() => runner.goto(runner.index + 1)}
                >
                  {t('tests.runner.next')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {runner.current && (
        <TestRunnerDefect
          isOpen={isDefectOpen}
          onOpenChange={setDefectOpen}
          projectPath={projectPath}
          groupId={runner.current.groupId}
          caseId={runner.current.caseId}
          runId={runner.current.runId}
        />
      )}
    </>
  );
}
