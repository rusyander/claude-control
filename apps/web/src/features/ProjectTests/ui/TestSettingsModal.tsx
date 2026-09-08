import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { TabButton } from '@shared/ui/tab-button';
import { Typography } from '@shared/ui/typography';
import { TestSettingsEnvironments } from './TestSettingsEnvironments';
import { TestSettingsSteps } from './TestSettingsSteps';
import { TestSettingsFields } from './TestSettingsFields';
import type { TestSettingsModalProps } from './TestSettingsModal.types';
import styles from './ProjectTests.module.scss';

/** Разделы окна в порядке, в котором набор и заводят. */
const SECTIONS = ['environments', 'steps', 'fields'] as const;
type SettingsSection = (typeof SECTIONS)[number];

/**
 * Настройки набора: окружения, общие шаги, свои поля.
 *
 * Три файла проекта, которые панель ЧИТАЛА и всюду использовала — окружение в
 * пульте и в плане, общий шаг в редакторе кейса, своё поле колонкой в таблице,
 * — но завести их можно было только руками в JSON. Окно закрывает ровно этот
 * разрыв и ничего нового не выдумывает: те же файлы, те же маршруты.
 *
 * Одно окно на три раздела, а не три кнопки в панели: заводят их подряд и
 * редко, а искать «где тут окружения» в трёх разных местах — это ровно та
 * работа, которой раздел и должен избавлять.
 */
export function TestSettingsModal({ isOpen, onOpenChange, board }: TestSettingsModalProps) {
  const { t } = useTranslation();
  const [section, setSection] = useState<SettingsSection>('environments');
  const [error, setError] = useState<string | undefined>();

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) setError(undefined);
        onOpenChange(open);
      }}
      title={t('tests.settings.title')}
      description={t('tests.settings.hint')}
      size="lg"
    >
      <Stack gap="var(--spacing-md)">
        {/* Сломанный файл называется ДО списков: пустой раздел под ним — это
            «не прочитали», а не «ничего не заведено», и правка в такой файл
            сервером не принимается. */}
        {board.libraryIssues.length > 0 && (
          <Stack gap="var(--spacing-3xs)" className={styles.issueBox}>
            <Typography variant="body-sm" weight="medium" color="warning">
              {t('tests.settings.brokenTitle')}
            </Typography>
            {board.libraryIssues.map((issue) => (
              <Typography key={issue.file} variant="caption" as="span">
                {issue.file} — {issue.error}
              </Typography>
            ))}
            <Typography variant="caption" color="subtle" as="span">
              {t('tests.settings.brokenHint')}
            </Typography>
          </Stack>
        )}

        <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
          {SECTIONS.map((item) => (
            <TabButton
              key={item}
              isActive={item === section}
              onClick={() => {
                setSection(item);
                setError(undefined);
              }}
            >
              {t(`tests.settings.tab.${item}`)}
            </TabButton>
          ))}
        </Stack>

        {section === 'environments' && (
          <TestSettingsEnvironments board={board} onError={setError} />
        )}
        {section === 'steps' && <TestSettingsSteps board={board} onError={setError} />}
        {section === 'fields' && <TestSettingsFields board={board} onError={setError} />}

        {error && (
          <Typography variant="caption" color="danger">
            {error}
          </Typography>
        )}

        <Typography variant="caption" color="subtle">
          {t('tests.settings.where', { dir: board.dir })}
        </Typography>
      </Stack>
    </Modal>
  );
}
