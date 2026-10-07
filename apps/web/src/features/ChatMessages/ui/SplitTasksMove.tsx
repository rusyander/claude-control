import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { SplitTaskOutcome, SplitTasksMoved } from '@agentdeck/contracts/chat-handoff';
import { splitTasksKeys, useMoveSplitTasks, useSplitTaskOptions } from '@entities/ChatTree';
import { toErrorMessage } from '@shared/api/client';
import { SETTINGS_ROUTE } from '@shared/config/routes';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { Modal } from '@shared/ui/modal';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import type { SplitTasksMoveProps } from './SplitTasksMove.types';
import styles from './SplitTasksMove.module.scss';

const OUTCOME_COLOR: Record<SplitTaskOutcome, 'success' | 'subtle' | 'warning' | 'danger'> = {
  moved: 'success',
  already: 'subtle',
  unavailable: 'warning',
  failed: 'danger',
  skipped: 'subtle',
};

/**
 * «Перевести задачи» (G4, владелец 05.10.2026): задачи трекера групп с MR — в
 * выбранный статус Jira. Окно сначала читает задачи и показывает, где каждая
 * стоит сейчас, и предлагает только статусы, доступные всем; нажатие
 * «Перевести» и есть согласие — переводит панель сама, второго вопроса нет.
 * Итог — по каждой задаче: переведена, уже там, перехода нет, ошибка.
 * «Из статуса» (владелец 06.10) сужает перевод до задач, что стоят в нём сейчас,
 * и предлагает статусы, доступные именно им; «Все задачи» — прежний выбор.
 */
export function SplitTasksMove({ parentChatId, index, keys, connected }: SplitTasksMoveProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState('');
  const [from, setFrom] = useState('');
  const [result, setResult] = useState<SplitTasksMoved>();
  const scope = { parentChatId, ...(index === undefined ? {} : { index }) };
  const options = useSplitTaskOptions(scope, open && !result && connected);
  const move = useMoveSplitTasks();
  const all = index === undefined;

  const source = options.data?.from.find((entry) => entry.status === from);
  const statuses = (source ? source.targets : options.data?.statuses) ?? [];
  const status = statuses.includes(picked) ? picked : (statuses[0] ?? '');

  const close = (): void => {
    setOpen(false);
    setResult(undefined);
    setPicked('');
    setFrom('');
    move.reset();
  };

  const submit = (): void => {
    if (!status || move.isPending) return;
    move.mutate(
      { ...scope, status, ...(source ? { from: source.status } : {}) },
      {
        onSuccess: (moved) => {
          setResult(moved);
          toast.success(
            t('chat.cascade.hub.moveTasks.toast', {
              moved: moved.items.filter((item) => item.outcome === 'moved').length,
              total: moved.items.length,
            }),
          );
          void queryClient.invalidateQueries({ queryKey: splitTasksKeys.options(scope) });
        },
        onError: (error) =>
          toast.error(t('chat.cascade.hub.moveTasks.failed', { message: toErrorMessage(error) })),
      },
    );
  };

  const content = (): ReactNode => {
    if (!connected) {
      return (
        <Typography variant="body-sm" color="warning" data-move-tasks-offline>
          {t('chat.cascade.hub.moveTasks.offline')}
        </Typography>
      );
    }
    if (result) {
      return (
        <ul className={styles.rows} data-move-tasks-result>
          {result.items.map((item) => (
            <li key={item.key} className={styles.row} data-outcome={item.outcome}>
              <Typography variant="mono" as="span">
                {item.key}
              </Typography>
              <Typography
                variant="body-sm"
                as="span"
                color={OUTCOME_COLOR[item.outcome]}
                className={styles.wide}
              >
                {t(`chat.cascade.hub.moveTasks.outcomes.${item.outcome}`, {
                  reason: item.reason ?? '',
                })}
              </Typography>
            </li>
          ))}
        </ul>
      );
    }
    if (options.isPending) {
      return (
        <Typography variant="body-sm" color="subtle">
          {t('chat.cascade.hub.moveTasks.loading')}
        </Typography>
      );
    }
    if (options.isError) {
      return (
        <Typography variant="body-sm" color="danger" data-move-tasks-error>
          {t('chat.cascade.hub.moveTasks.loadFailed', { message: toErrorMessage(options.error) })}
        </Typography>
      );
    }
    const { keys: read, unread } = options.data;
    return (
      <>
        <ul className={styles.rows} data-move-tasks-keys>
          {read.map((item) => {
            const failure = unread.find((entry) => entry.key === item.key);
            return (
              <li key={item.key} className={styles.row}>
                <Typography variant="mono" as="span">
                  {item.key}
                </Typography>
                <Typography
                  variant="body-sm"
                  as="span"
                  color="subtle"
                  className={styles.group}
                  title={item.group}
                >
                  {item.group}
                </Typography>
                <Typography variant="body-sm" as="span" color={failure ? 'danger' : 'default'}>
                  {failure
                    ? t('chat.cascade.hub.moveTasks.unread', { reason: failure.reason })
                    : item.status}
                </Typography>
              </li>
            );
          })}
        </ul>
        {options.data.from.length > 1 && (
          <SelectField
            label={t('chat.cascade.hub.moveTasks.from')}
            hint={t('chat.cascade.hub.moveTasks.fromHint')}
            value={source ? source.status : ''}
            onChange={(next) => {
              setFrom(next);
              setPicked('');
            }}
            options={[
              { value: '', label: t('chat.cascade.hub.moveTasks.fromAll') },
              ...options.data.from.map((entry) => ({
                value: entry.status,
                label: t('chat.cascade.hub.moveTasks.fromOption', {
                  status: entry.status,
                  count: entry.count,
                }),
              })),
            ]}
          />
        )}
        {statuses.length > 0 ? (
          <SelectField
            label={t('chat.cascade.hub.moveTasks.status')}
            hint={t(
              source
                ? 'chat.cascade.hub.moveTasks.statusHintFrom'
                : 'chat.cascade.hub.moveTasks.statusHint',
            )}
            value={status}
            onChange={setPicked}
            options={statuses.map((name) => ({ value: name, label: name }))}
          />
        ) : (
          <Typography variant="body-sm" color="warning" data-move-tasks-none>
            {t(
              source
                ? 'chat.cascade.hub.moveTasks.noStatusFrom'
                : 'chat.cascade.hub.moveTasks.noStatus',
            )}
          </Typography>
        )}
      </>
    );
  };

  const offlineFooter = (
    <>
      <Button size="sm" variant="ghost" onClick={close}>
        {t('chat.cascade.hub.moveTasks.cancel')}
      </Button>
      <Button
        size="sm"
        variant="primary"
        data-move-tasks-connect
        onClick={() => {
          close();
          void navigate({ to: SETTINGS_ROUTE, search: { tab: 'integrations' } } as never);
        }}
      >
        {t('chat.cascade.hub.moveTasks.connect')}
      </Button>
    </>
  );
  const footer = result ? (
    <Button size="sm" variant="primary" onClick={close}>
      {t('chat.cascade.hub.moveTasks.done')}
    </Button>
  ) : (
    <>
      <Button size="sm" variant="ghost" onClick={close}>
        {t('chat.cascade.hub.moveTasks.cancel')}
      </Button>
      <Button
        size="sm"
        variant="primary"
        disabled={!status}
        isLoading={move.isPending}
        data-move-tasks-submit
        onClick={submit}
      >
        {t('chat.cascade.hub.moveTasks.submit')}
      </Button>
    </>
  );

  return (
    <>
      <Button
        size="sm"
        variant={all ? 'ghost' : 'secondary'}
        title={t(all ? 'chat.cascade.hub.moveTasks.hintAll' : 'chat.cascade.hub.moveTasks.hint')}
        data-move-tasks={all ? 'all' : index}
        onClick={() => setOpen(true)}
      >
        {all
          ? t('chat.cascade.hub.moveTasks.actionAll')
          : t('chat.cascade.hub.moveTasks.action', { count: keys?.length ?? 0 })}
      </Button>
      <Modal
        isOpen={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        title={t('chat.cascade.hub.moveTasks.title')}
        size="md"
        footer={<div className={styles.footer}>{connected ? footer : offlineFooter}</div>}
      >
        <div className={styles.body} data-move-tasks-dialog>
          {content()}
        </div>
      </Modal>
    </>
  );
}
