import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import type { SourceDraft } from './inboxSources.types';

const P = 'coreInbox.sources';

interface ToggleRowProps {
  label: string;
  aria: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** Переключатель с видимой подписью; имя для скринридера несёт и имя источника. */
function ToggleRow({ label, aria, hint, checked, onChange }: ToggleRowProps) {
  return (
    <Stack gap="var(--spacing-3xs)">
      <Stack direction="row" gap="var(--spacing-xs)" align="center">
        <Toggle size="sm" checked={checked} onCheckedChange={onChange} aria-label={aria} />
        <Typography variant="body-sm" as="span">
          {label}
        </Typography>
      </Stack>
      {hint && (
        <Typography variant="caption" color="subtle" as="p">
          {hint}
        </Typography>
      )}
    </Stack>
  );
}

interface SourceEditorProps {
  draft: SourceDraft;
  index: number;
  onChange: (patch: Partial<SourceDraft>) => void;
  onRemove: () => void;
}

/**
 * Карточка одного источника в окне. `data-inbox-source` — текущее имя (меняется вместе с полем),
 * `data-inbox-source-index` — место в списке: по нему карточку находит проверка, пока имя правят.
 */
export function SourceEditor({ draft, index, onChange, onRemove }: SourceEditorProps) {
  const { t } = useTranslation();
  const id = draft.id;
  return (
    <Card padding="sm" data-inbox-source={id} data-inbox-source-index={index}>
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center">
          <Typography variant="body-sm" weight="medium" as="h3">
            {t(`${P}.systems.${draft.system}`)}
          </Typography>
          <Stack flex={1} />
          <Toggle
            size="sm"
            checked={draft.enabled}
            onCheckedChange={(enabled) => onChange({ enabled })}
            aria-label={t(`${P}.enabled`, { id })}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={t(`${P}.remove`, { id })}
            title={t(`${P}.remove`, { id })}
            onClick={onRemove}
            data-inbox-remove
          >
            <Icon name="trash" size={16} />
          </Button>
        </Stack>
        <TextField
          label={t(`${P}.id`)}
          value={draft.id}
          onChange={(value) => onChange({ id: value })}
          hint={t(`${P}.idHint`)}
          isMono
        />
        <ToggleRow
          label={t(`${P}.autoQueue`, { id })}
          aria={t(`${P}.autoQueue`, { id })}
          hint={t(`${P}.autoQueueHint`)}
          checked={draft.autoQueue}
          onChange={(autoQueue) => onChange({ autoQueue })}
        />
        {draft.system === 'jira' ? (
          <>
            <TextField
              label={t(`${P}.labels`)}
              value={draft.labels}
              onChange={(labels) => onChange({ labels })}
              hint={t(`${P}.labelsHint`)}
            />
            <ToggleRow
              label={t(`${P}.assignedToMe`, { id })}
              aria={t(`${P}.assignedToMe`, { id })}
              checked={draft.assignedToMe}
              onChange={(assignedToMe) => onChange({ assignedToMe })}
            />
            <TextField
              label={t(`${P}.jql`)}
              value={draft.jql}
              onChange={(jql) => onChange({ jql })}
              hint={t(`${P}.jqlHint`)}
              isMono
            />
          </>
        ) : (
          <>
            <TextField
              label={t(`${P}.issueLabels`)}
              value={draft.labels}
              onChange={(labels) => onChange({ labels })}
              hint={t(`${P}.labelsHint`)}
            />
            <ToggleRow
              label={t(`${P}.issuesAssigned`, { id })}
              aria={t(`${P}.issuesAssigned`, { id })}
              checked={draft.assignedToMe}
              onChange={(assignedToMe) => onChange({ assignedToMe })}
            />
            <ToggleRow
              label={t(`${P}.reviewerMrs`, { id })}
              aria={t(`${P}.reviewerMrs`, { id })}
              checked={draft.reviewerMrs}
              onChange={(reviewerMrs) => onChange({ reviewerMrs })}
            />
            <ToggleRow
              label={t(`${P}.ownMrs`, { id })}
              aria={t(`${P}.ownMrs`, { id })}
              checked={draft.ownMrsWithThreads}
              onChange={(ownMrsWithThreads) => onChange({ ownMrsWithThreads })}
            />
          </>
        )}
        <TextField
          label={t(`${P}.repos`)}
          value={draft.repos}
          onChange={(repos) => onChange({ repos })}
          hint={t(`${P}.reposHint`)}
          multiline
          rows={2}
          isMono
        />
        <TextField
          label={t(`${P}.bugLabels`)}
          value={draft.bugLabels}
          onChange={(bugLabels) => onChange({ bugLabels })}
          hint={t(`${P}.bugLabelsHint`)}
        />
      </Stack>
    </Card>
  );
}
