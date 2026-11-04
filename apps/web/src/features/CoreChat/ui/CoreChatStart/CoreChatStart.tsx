import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjects } from '@entities/Project';
import { useProviders } from '@entities/Provider';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { ChatStartError, startCoreChat } from '../../api/chatApi';
import { carryRefusalLine } from '../../model/chatRefusal';
import { chatCliOptions, chatFields, type ChatStartProblem } from '../../model/chatStart';
import type { ChatStartDraft } from '../../model/coreChat.types';
import type { CoreChatStartProps } from './CoreChatStart.types';

/**
 * Форма нового чата: папка проекта (список — проекты панели, путь можно вписать), CLI и первое
 * сообщение. Отправка — оценка ядра, выбор CLI и запуск; дальше страница открывает чат по номеру.
 */
export function CoreChatStart({
  onStarted,
  initialProject,
  initialCli,
  resume,
}: CoreChatStartProps) {
  const { t } = useTranslation();
  const P = 'coreChat.start';
  const projects = useProjects();
  const [draft, setDraft] = useState<ChatStartDraft>({
    project: initialProject ?? '',
    cli: initialCli ?? 'claude',
    text: '',
    ...(resume !== undefined ? { resume } : {}),
  });
  const [problem, setProblem] = useState<ChatStartProblem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const known = (projects.data ?? []).filter((p) => p.exists);
  const providers = useProviders().data?.providers ?? [];
  const nameOf = new Map(providers.map((p) => [p.id, p.name]));
  const clis = chatCliOptions(
    providers.map((p) => p.id),
    draft.cli,
  );

  const submit = async () => {
    const got = chatFields(draft);
    if (!got.ok) {
      setProblem(got.problem);
      return;
    }
    setProblem(null);
    setFailure(null);
    setPending(true);
    try {
      onStarted(await startCoreChat(draft));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Слой панели не перенёсся — причина панели своими словами, а не голым кодом; причина с
      // выходом для человека (локальный слой не влез, G14 p7) — её собственным текстом.
      const carry = error instanceof ChatStartError && error.kind === 'carry';
      const line = carry ? carryRefusalLine(message) : null;
      if (line) setFailure(t(`coreChat.launchRefused.${line.key}`, line.params));
      else setFailure(carry ? t(`${P}.carryRefused`, { detail: message }) : message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Card padding="lg" data-core-chat-start>
      <Stack gap="var(--spacing-md)">
        <Typography variant="heading-sm" as="h2">
          {t(draft.resume !== undefined ? `${P}.resumeHeading` : `${P}.heading`)}
        </Typography>
        {draft.resume !== undefined && (
          <Typography color={problem === 'resume' ? 'danger' : 'muted'} data-core-chat-resume>
            {t(problem === 'resume' ? `${P}.problems.resume` : `${P}.resumeNote`, {
              id: draft.resume,
            })}
          </Typography>
        )}
        {known.length > 0 && (
          <div data-core-chat-known-projects>
            <SelectField
              label={t(`${P}.pickProject`)}
              value={known.some((p) => p.path === draft.project) ? draft.project : ''}
              onChange={(project) => setDraft((d) => ({ ...d, project }))}
              options={[
                { value: '', label: '—' },
                ...known.map((p) => ({ value: p.path, label: `${p.name} — ${p.path}` })),
              ]}
            />
          </div>
        )}
        <div data-core-chat-project>
          <TextField
            label={t(`${P}.project`)}
            value={draft.project}
            onChange={(project) => setDraft((d) => ({ ...d, project }))}
            hint={t(`${P}.projectHint`)}
            error={problem === 'project' ? t(`${P}.problems.project`) : undefined}
            isMono
          />
        </div>
        <div data-core-chat-cli>
          <SelectField
            label={t(`${P}.cli`)}
            value={draft.cli}
            onChange={(cli) => setDraft((d) => ({ ...d, cli }))}
            options={clis.map((cli) => ({ value: cli, label: nameOf.get(cli) ?? cli }))}
            hint={t(draft.resume !== undefined ? `${P}.cliResumeHint` : `${P}.cliHint`)}
            disabled={draft.resume !== undefined}
          />
        </div>
        <div data-core-chat-first>
          <TextField
            label={t(`${P}.message`)}
            value={draft.text}
            onChange={(text) => setDraft((d) => ({ ...d, text }))}
            placeholder={t(`${P}.messagePlaceholder`)}
            error={problem === 'text' ? t(`${P}.problems.text`) : undefined}
            multiline
            rows={4}
          />
        </div>
        {failure && (
          <Typography color="danger" data-core-chat-start-failed>
            {t(`${P}.failed`, { reason: failure })}
          </Typography>
        )}
        <Stack direction="row" justify="end">
          <Button onClick={() => void submit()} isLoading={pending} data-core-chat-submit>
            {t(`${P}.submit`)}
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}
