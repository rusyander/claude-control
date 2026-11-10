import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfigView } from '@agentdeck/contracts/core/config';
import type { InboxSystem } from '@agentdeck/contracts/core/inbox';
import { boardMoveRefusalOf, type BoardMoveRefusal } from '@entities/CoreTask';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Modal } from '@shared/ui/modal';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { useInboxConfig, useSaveInbox } from '../Inbox/inboxApi';
import { draftOf, newSourceDraft, pollChoices, sectionOf } from './inboxSources.lib';
import type { InboxDraft, SourceDraft } from './inboxSources.types';
import { SourceEditor } from './SourceEditor';

const P = 'coreInbox.sources';

interface InboxSourcesProps {
  /** Настройка ядра на момент открытия: от её отпечатка пойдёт запись. */
  view: ConfigView;
  onClose: () => void;
}

/**
 * Окно «Источники входящих» (этап 12, I7, D16, D28): черновик раздела `inbox` и его запись целиком
 * через `POST /v1/config` от отпечатка настройки, с которой окно открыто. Настройку записали мимо
 * окна — ядро отвечает 409, окно показывает причину и «Перечитать настройку», а не перетирает.
 * GitHub виден в выборе системы, но не выбирается: входящих у него нет.
 */
export function InboxSources({ view, onClose }: InboxSourcesProps) {
  const { t } = useTranslation();
  const config = useInboxConfig();
  const save = useSaveInbox();
  const [base, setBase] = useState(view);
  const [draft, setDraft] = useState<InboxDraft>(() => draftOf(view.doc.inbox));
  const [system, setSystem] = useState<InboxSystem>('jira');
  const [error, setError] = useState<BoardMoveRefusal | null>(null);
  const result = sectionOf(draft);
  const issues = base.issues.filter((issue) => issue.section === 'inbox');

  const patchSource = (key: string, patch: Partial<SourceDraft>) =>
    setDraft((prev) => ({
      ...prev,
      sources: prev.sources.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    }));
  const addSource = () =>
    setDraft((prev) => ({
      ...prev,
      sources: [
        ...prev.sources,
        newSourceDraft(
          system,
          prev.sources.map((s) => s.id),
        ),
      ],
    }));
  const removeSource = (key: string) =>
    setDraft((prev) => ({ ...prev, sources: prev.sources.filter((s) => s.key !== key) }));

  const submit = () => {
    if (!result.ok) return;
    setError(null);
    save.mutate(
      { view: base, section: result.section },
      { onSuccess: onClose, onError: (e) => setError(boardMoveRefusalOf(e)) },
    );
  };

  // Перечитать: черновик собирается заново из свежей настройки — правки окна сознательно теряются.
  const reload = async () => {
    const fresh = await config.refetch();
    if (!fresh.data) return;
    setBase(fresh.data);
    setDraft(draftOf(fresh.data.doc.inbox));
    setError(null);
  };

  return (
    <Modal
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={t(`${P}.title`)}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t(`${P}.cancel`)}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!result.ok || save.isPending}
            isLoading={save.isPending}
            data-inbox-save
          >
            {save.isPending ? t(`${P}.saving`) : t(`${P}.save`)}
          </Button>
        </>
      }
    >
      <Stack gap="var(--spacing-md)" data-inbox-sources>
        <Typography variant="body-sm" as="p">
          {t(`${P}.intro`)}
        </Typography>
        {base.drift && (
          <Typography variant="body-sm" color="warning" as="p" data-inbox-drift>
            {t(`${P}.drift`)}
          </Typography>
        )}
        {issues.map((issue) => (
          <Typography key={issue.reason} variant="body-sm" color="danger" as="p" data-inbox-issue>
            {t(`${P}.issue`, { reason: issue.reason })}
          </Typography>
        ))}
        {draft.sources.length === 0 && (
          <Typography variant="body-sm" color="subtle" as="p" data-inbox-sources-empty>
            {t(`${P}.empty`)}
          </Typography>
        )}
        {draft.sources.map((source, index) => (
          <SourceEditor
            key={source.key}
            draft={source}
            index={index}
            onChange={(patch) => patchSource(source.key, patch)}
            onRemove={() => removeSource(source.key)}
          />
        ))}
        <Stack direction="row" gap="var(--spacing-sm)" align="end" wrap>
          <Stack flex={1} minWidth="220px">
            <SelectField
              label={t(`${P}.system`)}
              value={system}
              onChange={(value) => setSystem(value as InboxSystem)}
              options={[
                { value: 'jira', label: t(`${P}.systems.jira`) },
                { value: 'gitlab', label: t(`${P}.systems.gitlab`) },
                { value: 'github', label: t(`${P}.systems.github`), disabled: true },
              ]}
              hint={t(`${P}.githubNote`)}
            />
          </Stack>
          <Button
            variant="secondary"
            leftIcon={<Icon name="plus" size={16} />}
            onClick={addSource}
            data-inbox-add
          >
            {t(`${P}.add`)}
          </Button>
        </Stack>
        <Stack direction="row" gap="var(--spacing-md)" align="end" wrap>
          <Stack minWidth="160px">
            <SelectField
              label={t(`${P}.poll`)}
              value={String(draft.pollMinutes)}
              onChange={(value) => setDraft((prev) => ({ ...prev, pollMinutes: Number(value) }))}
              options={pollChoices(draft.pollMinutes).map((m) => ({
                value: String(m),
                label: t(`${P}.pollMinutes`, { count: m }),
              }))}
            />
          </Stack>
          <Stack flex={1} minWidth="220px" gap="var(--spacing-3xs)">
            <Stack direction="row" gap="var(--spacing-xs)" align="center">
              <Toggle
                size="sm"
                checked={draft.commentBack}
                onCheckedChange={(commentBack) => setDraft((prev) => ({ ...prev, commentBack }))}
                aria-label={t(`${P}.commentBack`)}
              />
              <Typography variant="body-sm" as="span">
                {t(`${P}.commentBack`)}
              </Typography>
            </Stack>
            <Typography variant="caption" color="subtle" as="p">
              {t(`${P}.commentBackHint`)}
            </Typography>
          </Stack>
        </Stack>
        {!result.ok && (
          <Stack as="ul" gap="var(--spacing-3xs)" data-inbox-problems>
            {result.problems.map((problem, i) => (
              <Typography key={i} variant="body-sm" color="danger" as="li">
                {t(`${P}.problems.${problem.code}`, {
                  ...problem.values,
                  ...(problem.values.field
                    ? { field: t(`${P}.problems.fields.${problem.values.field}`) }
                    : {}),
                })}
              </Typography>
            ))}
          </Stack>
        )}
        {error && (
          <Stack direction="row" gap="var(--spacing-sm)" align="center" wrap data-inbox-error>
            <Typography variant="body-sm" color="danger" as="p" role="alert">
              {t(`${P}.failed`, { reason: error.reason })}
            </Typography>
            {error.status === 409 && (
              <Button variant="secondary" size="sm" onClick={() => void reload()} data-inbox-reload>
                {t(`${P}.reload`)}
              </Button>
            )}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
