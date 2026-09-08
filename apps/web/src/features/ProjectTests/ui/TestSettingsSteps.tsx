import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestSharedStep } from '@agentdeck/contracts';
import { stepText } from '@agentdeck/contracts/test-format';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { toErrorMessage } from '@shared/api/client';
import { sharedStepUsage } from '../model/testSettings';
import type { TestSettingsSectionProps } from './TestSettingsModal.types';
import styles from './ProjectTests.module.scss';

/**
 * Общие шаги: то, что повторяется в каждом втором кейсе.
 *
 * Шаги вводятся построчно, потому что так их и пишут: «Открыть форму входа» с
 * новой строки. Разбор строки в шаг — тот же, что у файла (`toSteps` на
 * сервере), поэтому «действие · ожидание: …» здесь и в JSON значит одно и то же.
 *
 * Рядом с каждым шагом — в скольких кейсах он используется: это единственное,
 * что нужно знать перед удалением, и считается оно по ссылкам в кейсах, а не по
 * названиям.
 */
export function TestSettingsSteps({ board, onError }: TestSettingsSectionProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [lines, setLines] = useState('');
  const [editing, setEditing] = useState('');
  const [removing, setRemoving] = useState('');
  const [isBusy, setBusy] = useState(false);

  const usage = sharedStepUsage(board.groups);

  const send = async (action: () => Promise<unknown>): Promise<void> => {
    onError(undefined);
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      onError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const reset = (): void => {
    setTitle('');
    setLines('');
    setEditing('');
  };

  const save = (): Promise<void> =>
    send(async () => {
      await board.saveSharedStep({
        ...(editing ? { id: editing } : {}),
        title: title.trim(),
        // Пустые строки не шаги: человек разделяет ими куски, а не заводит их.
        steps: lines
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((action) => ({ action })),
      } as ProjectTestSharedStep);
      reset();
    });

  const edit = (step: ProjectTestSharedStep): void => {
    setEditing(step.id);
    setTitle(step.title);
    setLines(step.steps.map((item) => stepText(item)).join('\n'));
    setRemoving('');
    onError(undefined);
  };

  return (
    <Stack gap="var(--spacing-md)">
      <Stack gap="var(--spacing-2xs)">
        {board.sharedSteps.length === 0 && (
          <Typography variant="caption" color="subtle">
            {t('tests.settings.step.empty')}
          </Typography>
        )}

        {board.sharedSteps.map((step) => {
          const used = usage.get(step.id) ?? 0;
          return (
            <Stack key={step.id} gap="var(--spacing-3xs)" className={styles.secretRow}>
              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                <Typography weight="medium" as="span">
                  {step.title}
                </Typography>
                <Typography variant="mono" color="subtle" as="span">
                  {step.id}
                </Typography>
                {/* Ноль в русском множественном числе попадает в ту же форму,
                    что и пять («в 0 кейсах»), поэтому у него своя строка. */}
                <Badge tone={used > 0 ? 'info' : 'neutral'}>
                  {used > 0
                    ? t('tests.settings.step.used', { count: used })
                    : t('tests.settings.step.usedNone')}
                </Badge>
              </Stack>

              <Typography variant="caption" color="subtle">
                {step.steps.map((item) => item.action).join(' → ')}
              </Typography>

              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                <Button variant="ghost" size="sm" onClick={() => edit(step)}>
                  {t('tests.settings.edit')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Icon name="trash" size={16} />}
                  onClick={() => setRemoving(removing === step.id ? '' : step.id)}
                >
                  {t('tests.settings.remove')}
                </Button>
              </Stack>

              {/* Ссылка на удалённый шаг остаётся в кейсе подписью и ничего не
                  ломает — но кейс теряет его содержимое, и сказать об этом надо
                  здесь, а не потом на прогоне. */}
              {removing === step.id && (
                <Stack gap="var(--spacing-3xs)">
                  <Typography variant="caption" color={used > 0 ? 'warning' : 'subtle'}>
                    {used > 0
                      ? t('tests.settings.step.removeUsed', { count: used })
                      : t('tests.settings.step.removeHint')}
                  </Typography>
                  <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                    <Button
                      variant="danger"
                      size="sm"
                      isLoading={isBusy}
                      onClick={() =>
                        void send(async () => {
                          await board.removeSharedStep(step.id);
                          setRemoving('');
                          if (editing === step.id) reset();
                        })
                      }
                    >
                      {t('tests.settings.removeConfirm')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRemoving('')}>
                      {t('tests.settings.cancel')}
                    </Button>
                  </Stack>
                </Stack>
              )}
            </Stack>
          );
        })}
      </Stack>

      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body-sm" weight="medium">
          {editing
            ? t('tests.settings.step.editTitle', { title: editing })
            : t('tests.settings.step.add')}
        </Typography>
        <TextField
          label={t('tests.settings.step.name')}
          placeholder={t('tests.settings.step.namePlaceholder')}
          value={title}
          onChange={setTitle}
        />
        <TextField
          label={t('tests.settings.step.lines')}
          hint={t('tests.settings.step.linesHint')}
          value={lines}
          onChange={setLines}
          multiline
          rows={4}
        />
        <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
          <Button
            variant="primary"
            isLoading={isBusy}
            disabled={title.trim().length === 0 || lines.trim().length === 0}
            onClick={() => void save()}
          >
            {editing ? t('tests.settings.save') : t('tests.settings.add')}
          </Button>
          {editing && (
            <Button variant="ghost" onClick={reset}>
              {t('tests.settings.cancel')}
            </Button>
          )}
        </Stack>
      </Stack>
    </Stack>
  );
}
