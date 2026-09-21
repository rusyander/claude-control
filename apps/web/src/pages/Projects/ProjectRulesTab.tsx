import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SkeletonList } from '@shared/ui/skeleton';
import { InstructionFilesCard } from '@shared/ui/instruction-files';
import { sameText } from '@shared/lib/same-text';
import { useProjectRules, useUpdateProjectRules } from '@entities/Project';
import type { ProjectTabProps } from './ProjectRulesTab.types';
import styles from './ProjectsPage.module.scss';

/**
 * Файл правил проекта целиком, как его читает сам Claude в каталоге проекта.
 * Правится как обычный текст; перед записью сервер делает резервную копию.
 *
 * ИМЯ файла — не константа (П2.7): проект без своего `CLAUDE.md` живёт на
 * `AGENTS.md`, и раскладку показывает карточка сверху. Панель ничего не
 * переименовывает и второго файла не заводит.
 */
export function ProjectRulesTab({ projectId }: ProjectTabProps) {
  const { t } = useTranslation();
  const { data, isLoading } = useProjectRules(projectId);
  const update = useUpdateProjectRules(projectId);
  const [value, setValue] = useState<string | undefined>(undefined);
  // Имя выбирается ТОЛЬКО пока файла нет; выбор живёт в состоянии вкладки и
  // уходит вместе с сохранением — панель ничего не переименовывает (П2.7).
  const [chosenName, setChosenName] = useState<string | undefined>(undefined);

  // Список проектов и содержимое переключаются — при смене проекта берём заново.
  useEffect(() => {
    setValue(undefined);
    setChosenName(undefined);
  }, [projectId]);

  useEffect(() => {
    if (data !== undefined && value === undefined) setValue(data.content);
  }, [data, value]);

  if (isLoading || value === undefined || data === undefined) {
    return <SkeletonList rows={6} withActions={false} />;
  }

  // Без учёта переносов: textarea отдаёт LF, файл на Windows — CRLF, и после
  // сохранения GET приносит CRLF обратно — строгое сравнение держало бы
  // «несохранённые правки» вечно.
  const dirty = !sameText(value, data.content);

  return (
    <Stack gap="var(--spacing-sm)">
      <InstructionFilesCard
        view={data.instructionFiles}
        chosenName={chosenName ?? data.fileName}
        onChooseName={setChosenName}
      />

      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="caption" color="subtle">
            {t('projectConfig.rulesHint', { file: data.fileName })}
          </Typography>

          <textarea
            className={styles.editor}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            spellCheck={false}
            aria-label={t('projectConfig.tab_rules')}
          />

          <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
            <Typography variant="caption" color="subtle">
              {t('claudeMd.chars', { count: value.length })}
              {dirty ? ` · ${t('claudeMd.unsaved')}` : ''}
            </Typography>

            <Stack direction="row" gap="var(--spacing-xs)">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setValue(data.content)}
                disabled={!dirty || update.isPending}
              >
                {t('claudeMd.revert')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Icon name="check" size={18} />}
                onClick={() =>
                  update.mutate({
                    content: value,
                    // Имя уходит только когда файла ещё нет: иначе сервер увидел
                    // бы просьбу переименовать существующий и ответил 409.
                    fileName: data.instructionFiles.proposed ? chosenName : undefined,
                  })
                }
                isLoading={update.isPending}
                disabled={!dirty}
              >
                {t('common.save')}
              </Button>
            </Stack>
          </Stack>

          <Typography variant="caption" color="subtle">
            {t('common.needsRestart')}
          </Typography>
        </Stack>
      </Card>
    </Stack>
  );
}
