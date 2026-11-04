import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GRANT_OPS } from '@agentdeck/contracts/core/journal';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { commandsFor, globsOf } from '../../model/askCommands';
import type { AskChoice, GrantOp } from '../../model/askCommands.types';
import { useAskSubmit } from '../../model/useAskSubmit';
import type { AskCardProps } from './AskCard.types';

/** Подпись варианта: у вопроса запуска варианты — действия экрана, у остальных — текст ядра. */
const LAUNCH_LABEL: Record<string, string> = {
  'approve-split': 'coreTimeline.ask.approve',
  cancel: 'coreTimeline.ask.cancel',
  'edit-split': 'coreTimeline.ask.editSplit',
};

/** Источники, чей вопрос ядро пишет на языке задачи (запуск, точки 6 и 7 дирижёра, сверка). */
const TASK_LANG_SOURCES: ReadonlySet<string> = new Set([
  'launch',
  'round-cap',
  'budget',
  'reconcile',
]);

/**
 * Карточка вопроса человеку (07:22): вопрос ядра дословно, варианты — кнопками, у вопроса модели —
 * свободный ответ, у вопроса права с «grant» — форма гранта. Ответ уходит командой с числом
 * страницы; отказ ядра (нет подписи, вопрос уже закрыт) показан его же словами под карточкой.
 */
export function AskCard({ taskId, ask, state }: AskCardProps) {
  const { t } = useTranslation();
  const { state: submit, submit: send } = useAskSubmit();
  const [text, setText] = useState('');
  const [grantOpen, setGrantOpen] = useState(false);
  const [project, setProject] = useState(ask.repoKey ?? '');
  const [globs, setGlobs] = useState(ask.permit?.target ?? '');
  const [ops, setOps] = useState<GrantOp[]>(['edit']);
  const closed = state !== null && state !== 'open';
  const busy = submit.status === 'sending' || submit.status === 'applied' || closed;

  const choose = (choice: AskChoice) => {
    const drafts = commandsFor(taskId, ask, choice);
    if (drafts) void send(drafts);
  };
  const grantDrafts = commandsFor(taskId, ask, {
    type: 'grant',
    project,
    globs: globsOf(globs),
    ops,
  });

  return (
    <Card padding="md" data-core-ask={ask.askId} data-ask-source={ask.source}>
      <Stack gap="var(--spacing-xs)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Badge tone="warning">{t('coreTimeline.ask.point', { point: ask.point })}</Badge>
          <Badge tone="neutral">{t(`coreTimeline.ask.source.${ask.source}`)}</Badge>
          {closed && (
            <Badge tone="success" data-ask-state={state}>
              {t(`coreTimeline.ask.answeredState.${state}`)}
            </Badge>
          )}
        </Stack>
        {/* Вопросы запуска, кругов, срока и сверки ядро пишет на языке панели, с которой задача запущена; прочие — английской прозой. */}
        <Typography
          variant="body-sm"
          lang={TASK_LANG_SOURCES.has(ask.source) ? undefined : 'en'}
          data-ask-question
        >
          {ask.question}
        </Typography>
        {ask.defaultAction && (
          <Typography variant="caption" color="muted">
            {t('coreTimeline.ask.defaultAction', { action: ask.defaultAction })}
          </Typography>
        )}
        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          {ask.options.map((option) => {
            const launchKey = ask.source === 'launch' ? LAUNCH_LABEL[option] : undefined;
            const label = launchKey ? t(launchKey) : option;
            if (option === 'grant') {
              return (
                <Button
                  key={option}
                  variant="secondary"
                  size="sm"
                  aria-expanded={grantOpen}
                  disabled={busy}
                  onClick={() => setGrantOpen((v) => !v)}
                  data-ask-option={option}
                >
                  {t('coreTimeline.ask.grant.title')}
                </Button>
              );
            }
            const editOnly = ask.source === 'launch' && option === 'edit-split';
            return (
              <Button
                key={option}
                variant={option === 'cancel' || option === 'refuse' ? 'ghost' : 'secondary'}
                size="sm"
                disabled={busy || editOnly}
                title={editOnly ? label : undefined}
                onClick={() =>
                  choose({
                    type: 'option',
                    option,
                    cancelReason: t('coreTimeline.ask.cancelReason'),
                  })
                }
                data-ask-option={option}
              >
                {label}
              </Button>
            );
          })}
        </Stack>
        {grantOpen && (
          <Stack gap="var(--spacing-xs)" data-ask-grant>
            <TextField
              label={t('coreTimeline.ask.grant.project')}
              value={project}
              onChange={setProject}
              isMono
            />
            <TextField
              label={t('coreTimeline.ask.grant.globs')}
              value={globs}
              onChange={setGlobs}
              multiline
              rows={3}
              isMono
            />
            <Typography variant="caption" color="muted">
              {t('coreTimeline.ask.grant.ops')}
            </Typography>
            <Stack direction="row" gap="var(--spacing-md)" wrap>
              {GRANT_OPS.map((op) => (
                <Stack key={op} direction="row" gap="var(--spacing-xs)" align="center">
                  <Toggle
                    size="sm"
                    checked={ops.includes(op)}
                    onCheckedChange={(on) =>
                      setOps((prev) => (on ? [...prev, op] : prev.filter((o) => o !== op)))
                    }
                    aria-label={t(`coreTimeline.ask.grant.op.${op}`)}
                  />
                  <Typography variant="body-sm" as="span">
                    {t(`coreTimeline.ask.grant.op.${op}`)}
                  </Typography>
                </Stack>
              ))}
            </Stack>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || grantDrafts === null}
              onClick={() => {
                if (grantDrafts) void send(grantDrafts);
              }}
              data-ask-grant-submit
            >
              {t('coreTimeline.ask.grant.submit')}
            </Button>
          </Stack>
        )}
        {ask.source === 'ask_human' && (
          <Stack gap="var(--spacing-xs)">
            <TextField
              label={t('coreTimeline.ask.answer')}
              value={text}
              onChange={setText}
              multiline
              rows={2}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !text.trim()}
              onClick={() => choose({ type: 'text', text })}
              data-ask-send
            >
              {t('coreTimeline.ask.send')}
            </Button>
          </Stack>
        )}
        <SubmitLine state={submit} />
      </Stack>
    </Card>
  );
}

function SubmitLine({ state }: { state: ReturnType<typeof useAskSubmit>['state'] }) {
  const { t } = useTranslation();
  if (state.status === 'applied') {
    return (
      <Typography variant="caption" color="success" data-ask-result="applied">
        {t('coreTimeline.ask.applied')}
      </Typography>
    );
  }
  if (state.status === 'rejected') {
    return (
      <Typography variant="caption" color="danger" data-ask-result="rejected" lang="en">
        {t('coreTimeline.ask.rejected', {
          reason: state.code ? `${state.code}: ${state.reason}` : state.reason,
        })}
      </Typography>
    );
  }
  if (state.status === 'failed') {
    return (
      <Typography variant="caption" color="danger" data-ask-result="failed" lang="en">
        {t('coreTimeline.ask.failed', { reason: state.reason })}
      </Typography>
    );
  }
  return null;
}
