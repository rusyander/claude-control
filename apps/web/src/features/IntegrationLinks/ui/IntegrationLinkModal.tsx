import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { IntegrationLink } from '@agentdeck/contracts';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import {
  useIntegrationLinks,
  useJiraProjects,
  useRemoveIntegrationLink,
  useSaveIntegrationLink,
} from '@entities/Integration';
import {
  cleanLink,
  pickLink,
  withConfluencePage,
  withJiraIssue,
  withoutConfluencePage,
  withoutJiraIssue,
} from '../model/linkDraft';
import { AtlassianSearchPicker } from './AtlassianSearchPicker';
import type { IntegrationLinkModalProps } from './IntegrationLinkModal.types';

/**
 * Привязка проекта или группы тестов к внешнему контексту.
 *
 * Одно окно на обе области намеренно: разница между «весь проект» и «эта
 * группа» — одна строка выбора, а два похожих окна разошлись бы полями. Смена
 * области перечитывает форму, потому что привязки у них РАЗНЫЕ, а не общие с
 * уточнением.
 *
 * Ничего не удаляется молча: «Отвязать» снимает привязку целиком и только по
 * нажатию — стёртое поле формы означает «не заполнено», а не «убрать связь».
 */
export function IntegrationLinkModal({
  isOpen,
  onOpenChange,
  projectPath,
  scopes,
  initialScope = '',
}: IntegrationLinkModalProps) {
  const { t } = useTranslation();
  const links = useIntegrationLinks(projectPath, isOpen);
  const save = useSaveIntegrationLink(projectPath);
  const remove = useRemoveIntegrationLink(projectPath);
  const jiraProjects = useJiraProjects(isOpen);

  const [scope, setScope] = useState(initialScope);
  const [draft, setDraft] = useState<IntegrationLink>({});

  // Форма собирается из привязки ВЫБРАННОЙ области: пока данные едут, показывать
  // чужие значения нельзя — их сохранят не глядя.
  useEffect(() => {
    setDraft(pickLink(links.data, scope));
  }, [links.data, scope]);

  useEffect(() => {
    if (isOpen) setScope(initialScope);
  }, [isOpen, initialScope]);

  const patch = (change: Partial<IntegrationLink>): void =>
    setDraft((current) => ({ ...current, ...change }));

  const submit = (): void => {
    save.mutate(
      { groupId: scope || undefined, link: cleanLink(draft) },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  const jiraChosen = draft.jiraIssueKey
    ? `${draft.jiraIssueKey}${draft.jiraIssueTitle ? ` · ${draft.jiraIssueTitle}` : ''}`
    : '';

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('integrations.links.title')}
      description={t('integrations.links.description')}
      size="lg"
      footer={
        <Stack direction="row" gap="var(--spacing-xs)" justify="end">
          <Button
            variant="ghost"
            onClick={() => remove.mutate(scope || undefined)}
            isLoading={remove.isPending}
          >
            {t('integrations.links.detach')}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} isLoading={save.isPending}>
            {t('common.save')}
          </Button>
        </Stack>
      }
    >
      <Stack gap="var(--spacing-sm)">
        {scopes.length > 1 && (
          <SelectField
            label={t('integrations.links.scope')}
            value={scope}
            onChange={setScope}
            hint={t('integrations.links.scopeHint')}
            options={scopes.map((item) => ({ value: item.id, label: item.title }))}
          />
        )}

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('integrations.links.jiraTitle')}
          </Typography>
          <AtlassianSearchPicker
            kind="jira"
            chosen={jiraChosen}
            onChoose={(key, title) =>
              setDraft((current) =>
                withJiraIssue(current, {
                  key,
                  summary: title,
                  status: '',
                  type: '',
                  url: '',
                }),
              )
            }
            onClear={() => setDraft((current) => withoutJiraIssue(current))}
          />
        </Stack>

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('integrations.links.confluenceTitle')}
          </Typography>
          <AtlassianSearchPicker
            kind="confluence"
            chosen={draft.confluencePageTitle ?? draft.confluencePageId ?? ''}
            onChoose={(id, title) =>
              setDraft((current) =>
                withConfluencePage(current, {
                  id,
                  title,
                  spaceKey: '',
                  url: '',
                }),
              )
            }
            onClear={() => setDraft((current) => withoutConfluencePage(current))}
          />
        </Stack>

        {/* Проект для НОВЫХ дефектов — отдельно от найденной задачи: заводят их
            в проект, а привязывают работу к эпику, и это разные вещи. */}
        <SelectField
          label={t('integrations.links.jiraProject')}
          value={draft.jiraProjectKey ?? ''}
          onChange={(value) => patch({ jiraProjectKey: value })}
          hint={t('integrations.links.jiraProjectHint')}
          options={[
            { value: '', label: t('integrations.option.unset') },
            ...(jiraProjects.data ?? []).map((item) => ({
              value: item.key,
              label: `${item.key} · ${item.name}`,
            })),
          ]}
        />

        <TextField
          label={t('integrations.links.forgeRepo')}
          value={draft.forgeRepo ?? ''}
          onChange={(value) => patch({ forgeRepo: value })}
          hint={t('integrations.links.forgeRepoHint')}
        />

        <TextField
          label={t('integrations.links.note')}
          value={draft.note ?? ''}
          onChange={(value) => patch({ note: value })}
          hint={t('integrations.links.noteHint')}
          multiline
          rows={3}
        />
      </Stack>
    </Modal>
  );
}
