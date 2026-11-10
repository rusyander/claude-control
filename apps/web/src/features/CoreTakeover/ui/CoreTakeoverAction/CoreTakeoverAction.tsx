import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { BOARD_STOPS, type BoardStop } from '@agentdeck/contracts/core/board';
import { Button } from '@shared/ui/button';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { takeoverActionsOf } from '../../model/takeoverActions';
import { useTakeoverSubmit } from '../../model/useTakeoverSubmit';
import type { CoreTakeoverActionProps } from './CoreTakeoverAction.types';
import { TakeoverStatus } from './TakeoverStatus';

const P = 'coreTakeover';
/** Старый адрес чата задачи ядра: переводит в `/chat` на разговор, который ведёт эта задача. */
const CORE_CHAT_ROUTE = '/core/chat';

/**
 * Ручное вмешательство на карточке задачи (P157, P161, P162): «Взять вручную» / «Вернуть ядру»,
 * «На доработку» словами и точка остановки до MR. Каждая кнопка — одна команда ядра; что из этого
 * видно, решает `takeoverActionsOf`, а принимает или отказывает — ядро (отказ его словами).
 */
export function CoreTakeoverAction({ taskId, card, onDone }: CoreTakeoverActionProps) {
  const { t } = useTranslation();
  const { state, submit } = useTakeoverSubmit(onDone);
  const [note, setNote] = useState('');
  const [text, setText] = useState('');
  const shown = takeoverActionsOf(card);
  if (!shown.takeOver && !shown.handBack && !shown.rework && !shown.setStop) return null;
  const busy = state.status === 'sending';
  const takeover = card.takeover;

  const handBack = async () => {
    const trimmed = note.trim();
    const fields: Record<string, string> = trimmed ? { note: trimmed } : {};
    if (await submit({ kind: 'hand-back', taskId, fields })) setNote('');
  };
  const rework = async () => {
    if (await submit({ kind: 'rework', taskId, fields: { text: text.trim() } })) setText('');
  };
  const setStop = (stop: string) =>
    void submit({ kind: 'set-stop', taskId, fields: { stop: stop as BoardStop } });

  return (
    <Stack gap="var(--spacing-sm)" data-core-takeover={takeover ? 'open' : 'closed'}>
      <Typography variant="body-sm" weight="medium" as="h3">
        {t(`${P}.heading`)}
      </Typography>
      {shown.takeOver && (
        <Stack gap="var(--spacing-xs)">
          <Typography variant="caption" color="muted">
            {t(`${P}.takeOverHint`)}
          </Typography>
          <Button
            variant="secondary"
            disabled={busy}
            data-takeover-open
            onClick={() => void submit({ kind: 'take-over', taskId, fields: {} })}
          >
            {t(`${P}.takeOver`)}
          </Button>
        </Stack>
      )}
      {shown.handBack && takeover && (
        <Stack gap="var(--spacing-xs)">
          <Typography variant="body-sm">{t(`${P}.open`)}</Typography>
          <Typography variant="caption" color="muted">
            {t(`${P}.copy`)}: <code>{takeover.copy}</code>
          </Typography>
          {takeover.chatTaskId && (
            <Link
              to={CORE_CHAT_ROUTE as never}
              search={{ id: takeover.chatTaskId } as never}
              data-takeover-chat
            >
              {t(`${P}.openChat`)}
            </Link>
          )}
          <TextField label={t(`${P}.note`)} value={note} onChange={setNote} multiline rows={2} />
          <Typography variant="caption" color="muted">
            {t(`${P}.handBackHint`)}
          </Typography>
          <Button disabled={busy} data-takeover-handback onClick={() => void handBack()}>
            {t(`${P}.handBack`)}
          </Button>
        </Stack>
      )}
      {shown.rework && (
        <Stack gap="var(--spacing-xs)">
          <TextField
            label={t(`${P}.reworkText`)}
            value={text}
            onChange={setText}
            multiline
            rows={2}
          />
          <Typography variant="caption" color="muted">
            {t(card.state === 'done' ? `${P}.reworkHintDone` : `${P}.reworkHintRunning`)}
          </Typography>
          <Button
            variant="secondary"
            disabled={busy || text.trim() === ''}
            data-takeover-rework
            onClick={() => void rework()}
          >
            {t(`${P}.rework`)}
          </Button>
        </Stack>
      )}
      {shown.setStop && (
        <SelectField
          label={t(`${P}.stop`)}
          hint={t(`${P}.stopHint`)}
          value={card.stop}
          onChange={setStop}
          disabled={busy}
          options={BOARD_STOPS.map((stop) => ({ value: stop, label: t(`${P}.stops.${stop}`) }))}
        />
      )}
      <TakeoverStatus state={state} />
    </Stack>
  );
}
