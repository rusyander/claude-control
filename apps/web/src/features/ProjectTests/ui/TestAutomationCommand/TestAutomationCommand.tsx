import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestAutomationRecipe } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { messageFromPayload } from '@shared/api/client';
import {
  useRemoveTestAutomation,
  useSaveTestAutomation,
  useTestAutomation,
} from '@entities/ProjectTest';
import {
  AUTOMATION_FORMATS,
  draftFrom,
  draftToSave,
  sameAutomation,
  type AutomationDraft,
} from '../../model/automationDraft';
import { TestAutomationRecipes } from './TestAutomationRecipes';
import type { TestAutomationCommandProps } from './TestAutomationCommand.types';
import styles from './TestAutomationCommand.module.scss';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

/**
 * Своя команда прогона — тесты бэкенда в разделе «Тесты».
 *
 * Папка e2e — это Playwright/Cypress/pytest; `go test`, Gradle, Maven и
 * `cargo test` панель гонит строкой из `.agent/tests/automation.json`. Раньше
 * этот файл писали руками; теперь панель сама находит по файлам проекта, какой
 * командой гнать (рецепты), называет недостающую программу ДО прогона, и
 * команда записывается кнопкой. Записанная — видна строкой с её отчётом.
 *
 * Правка — на месте, а не в окне: команда одна, полей четыре, и человек видит
 * рядом рецепт, из которого её взял. Пока идёт прогон, строку не меняют: он
 * гонит прежнюю, а итог подписал бы новой (сервер ответит 409 тем же).
 */
export function TestAutomationCommand({
  path,
  automation,
  isLocked,
  hasFolder,
}: TestAutomationCommandProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AutomationDraft | undefined>();
  /** Рецепт, из которого взята правка: его нехватку программы видно и в полях. */
  const [taken, setTaken] = useState<ProjectTestAutomationRecipe | undefined>();
  const [notice, setNotice] = useState<'saved' | 'removed' | undefined>();
  const editing = draft !== undefined;
  // Рецепты нужны, пока команды нет или её правят: обход проекта — не для опроса.
  const info = useTestAutomation(path, !automation || editing);
  const save = useSaveTestAutomation(path);
  const remove = useRemoveTestAutomation(path);
  const recipes = info.data?.recipes ?? [];
  const broken = info.data?.error
    ? messageFromPayload({ error: info.data.error, messageCode: info.data.messageCode })
    : undefined;

  const begin = (next: AutomationDraft, recipe?: ProjectTestAutomationRecipe) => {
    save.reset();
    remove.reset();
    setNotice(undefined);
    setTaken(recipe);
    setDraft(next);
  };
  const close = () => {
    setDraft(undefined);
    setTaken(undefined);
  };
  const patch = (fields: Partial<AutomationDraft>) =>
    setDraft((current) => (current ? { ...current, ...fields } : current));
  const lockedHint = isLocked ? t('testsE2e.automation.locked') : undefined;
  const failure = save.error ?? remove.error;
  const startCustom = (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={<Icon name="plus" size={16} />}
      disabled={isLocked}
      title={lockedHint ?? t('testsE2e.automation.intro')}
      onClick={() => begin(draftFrom(undefined))}
    >
      {t('testsE2e.automation.custom')}
    </Button>
  );

  // Папка e2e есть, своей команды нет и рецептов тоже — одна кнопка, без
  // объяснений: проекту на Playwright бэкенд-блок только мешал бы читать карточку.
  if (hasFolder && !automation && !editing && !broken && !notice && recipes.length === 0) {
    return info.isSuccess ? (
      <Stack direction="row" data-testid="tests-automation">
        {startCustom}
      </Stack>
    ) : null;
  }

  return (
    <Stack gap="var(--spacing-2xs)" data-testid="tests-automation">
      <Stack direction="row" gap="var(--spacing-xs)" align="center">
        <Icon name="scripts" size={16} />
        <Typography variant="caption" weight="medium" as="h4">
          {t('testsE2e.automation.title')}
        </Typography>
      </Stack>

      {broken && (
        <Typography variant="caption" color="danger" role="alert">
          {t('testsE2e.automation.broken', { reason: broken })}
        </Typography>
      )}

      {automation && !editing && (
        <>
          <code className={styles.command} data-testid="tests-automation-current">
            {automation.command}
          </code>
          <Typography variant="caption" color="subtle">
            {[
              t(`testsE2e.automation.format.${automation.format ?? 'junit'}`),
              automation.report
                ? t(
                    automation.report.endsWith('/')
                      ? 'testsE2e.automation.reportDir'
                      : 'testsE2e.automation.reportFile',
                    { report: automation.report },
                  )
                : '',
              automation.timeoutMinutes
                ? t('testsE2e.automation.timeout', { count: automation.timeoutMinutes })
                : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Typography>
          <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="edit" size={16} />}
              title={lockedHint}
              disabled={isLocked}
              onClick={() => begin(draftFrom(automation))}
            >
              {t('testsE2e.automation.edit')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title={lockedHint ?? t('testsE2e.automation.removeHint')}
              disabled={isLocked}
              isLoading={remove.isPending}
              onClick={() => {
                save.reset();
                setNotice(undefined);
                remove.mutate(undefined, { onSuccess: () => setNotice('removed') });
              }}
            >
              {t('testsE2e.automation.remove')}
            </Button>
          </Stack>
        </>
      )}

      {!automation && !editing && (
        <>
          <Typography variant="caption" color="subtle">
            {t('testsE2e.automation.intro')}
          </Typography>
          {info.isLoading && (
            <Typography variant="caption" color="subtle" role="status">
              {t('testsE2e.automation.searching')}
            </Typography>
          )}
          {recipes.length > 0 && (
            <>
              <Typography variant="caption" as="p">
                {t('testsE2e.automation.recipesTitle')}
              </Typography>
              <TestAutomationRecipes
                recipes={recipes}
                disabled={isLocked}
                onTake={(recipe) => begin(draftFrom(recipe.automation), recipe)}
              />
            </>
          )}
          {info.isSuccess && recipes.length === 0 && (
            <Typography variant="caption" color="subtle">
              {t('testsE2e.automation.noRecipes')}
            </Typography>
          )}
          <div>{startCustom}</div>
        </>
      )}

      {draft && (
        <Stack gap="var(--spacing-xs)" className={styles.fields}>
          {taken?.missing && (
            <Typography variant="caption" color="warning" role="status">
              {[
                t('testsE2e.automation.missing', { tool: taken.tool }),
                taken.install ? t('testsE2e.automation.install', { install: taken.install }) : '',
              ]
                .filter(Boolean)
                .join(' ')}
            </Typography>
          )}
          <TextField
            label={t('testsE2e.automation.fields.command')}
            value={draft.command}
            onChange={(command) => patch({ command })}
            hint={t('testsE2e.automation.fields.commandHint')}
            isMono
            autoFocus
          />
          <TextField
            label={t('testsE2e.automation.fields.report')}
            value={draft.report}
            onChange={(report) => patch({ report })}
            hint={t('testsE2e.automation.fields.reportHint')}
            placeholder="{report}"
            isMono
          />
          <SelectField
            label={t('testsE2e.automation.fields.format')}
            value={draft.format}
            onChange={(format) => patch({ format: format as AutomationDraft['format'] })}
            options={AUTOMATION_FORMATS.map((format) => ({
              value: format,
              label: t(`testsE2e.automation.format.${format}`),
            }))}
          />
          <TextField
            label={t('testsE2e.automation.fields.timeout')}
            value={draft.timeout}
            onChange={(timeout) => patch({ timeout })}
            hint={t('testsE2e.automation.fields.timeoutHint')}
          />
          <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
            <Button
              variant="primary"
              size="sm"
              title={lockedHint}
              disabled={isLocked || !draft.command.trim() || sameAutomation(draft, automation)}
              isLoading={save.isPending}
              onClick={() =>
                save.mutate(draftToSave(draft), {
                  onSuccess: () => {
                    close();
                    setNotice('saved');
                  },
                })
              }
            >
              {t('testsE2e.automation.save')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                save.reset();
                close();
              }}
            >
              {t('testsE2e.automation.cancel')}
            </Button>
          </Stack>
        </Stack>
      )}

      {notice && !failure && (
        <Typography variant="caption" color="success" role="status">
          {t(`testsE2e.automation.${notice}`)}
        </Typography>
      )}
      {failure && (
        <Typography variant="caption" color="danger" role="alert">
          {toErrorMessage(failure)}
        </Typography>
      )}
    </Stack>
  );
}
