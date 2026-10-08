import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { useTestRunDiff } from '@entities/ProjectTest';
import type { TestsRunDiffProps } from './TestsRunDiff.types';
import { serverFieldText } from '@shared/config/i18n';
import { DiffList } from './DiffList/DiffList';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/**
 * Что изменилось с прошлого прогона.
 *
 * Главный вопрос после регресса — «что сломалось с прошлого раза», и до этого
 * блока ответа на него не было: две записи истории открывались по отдельности, а
 * сотня кейсов глазами не сличается.
 *
 * Запрос уходит, только когда блок раскрыли: считать дифф на каждый показ
 * истории значило бы платить за ответ, которого никто не спрашивал. Первый
 * прогон сравнивать не с чем — сервер говорит это словами, и отказ показывается
 * как есть, без повторов.
 */
export function TestsRunDiff({ projectPath, runId, isOpenByDefault = false }: TestsRunDiffProps) {
  // Дата — языком интерфейса, а не браузера: английская панель иначе
  // показывала русские даты (F-323).
  const { t, i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(isOpenByDefault);
  const diff = useTestRunDiff(projectPath, runId, undefined, isOpen);

  if (!isOpen) {
    return (
      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Icon name="history" size={16} />}
          onClick={() => setIsOpen(true)}
        >
          {t('tests.diff.open')}
        </Button>
      </Stack>
    );
  }

  if (diff.isError) {
    return (
      <Typography variant="caption" color="subtle">
        {toErrorMessage(diff.error)}
      </Typography>
    );
  }

  if (!diff.data) {
    return (
      <Typography variant="caption" color="subtle">
        {t('tests.diff.loading')}
      </Typography>
    );
  }

  const data = diff.data;
  const isQuiet =
    data.newFailures.length === 0 &&
    data.fixed.length === 0 &&
    data.stillFailing.length === 0 &&
    data.added.length === 0 &&
    data.removed.length === 0;

  return (
    <Stack gap="var(--spacing-2xs)">
      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
        <Typography variant="caption" color="subtle" as="span">
          {t('tests.diff.base', {
            date: new Date(data.from.startedAt).toLocaleString(i18n.language),
          })}
        </Typography>
        {!isOpenByDefault && (
          <Button variant="ghost" size="sm" onClick={() => setIsOpen(false)}>
            {t('tests.diff.hide')}
          </Button>
        )}
      </Stack>

      {/* Сравнимость: прогон по другому плану или в другом окружении — другой
          набор, и «починилось» там часто значит «в этот раз не гоняли». */}
      {data.warning && (
        <Typography variant="caption" color="warning">
          {serverFieldText(data, 'warning')}
        </Typography>
      )}

      {isQuiet && (
        <Typography variant="caption" color="subtle">
          {t('tests.diff.quiet', { count: data.untouched.length })}
        </Typography>
      )}

      <DiffList title={t('tests.diff.newFailures')} tone="danger" items={data.newFailures} />
      <DiffList title={t('tests.diff.fixed')} tone="success" items={data.fixed} />
      <DiffList title={t('tests.diff.stillFailing')} tone="warning" items={data.stillFailing} />
      <DiffList title={t('tests.diff.added')} tone="info" items={data.added} />
      <DiffList title={t('tests.diff.removed')} tone="neutral" items={data.removed} />
    </Stack>
  );
}
