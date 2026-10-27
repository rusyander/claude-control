import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  bundleSplitTickets,
  clusterSplitTickets,
  openSplitTickets,
  type SplitTicketDuplicateChoice,
  type SplitTicketDuplicateDecision,
  type SplitTicketPublished,
} from '@agentdeck/contracts/split-ticket-batch';
import {
  chatTreeKeys,
  usePublishSplitTickets,
  useSplitTicketDuplicates,
  useSplitTicketTarget,
  useTakeSplitTickets,
} from '@entities/ChatTree';
import { SETTINGS_ROUTE } from '@shared/config/routes';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { Modal } from '@shared/ui/modal';
import type {
  DuplicatesState,
  SplitTicketResolveProps,
  TargetState,
} from './SplitTicketResolve.types';
import { duplicateDecisions } from './SplitTicketDuplicates';
import { SplitTicketResolveBody } from './SplitTicketResolveBody';
import { SplitTicketResolveActions } from './SplitTicketResolveActions';
import { readLastProject, writeLastProject } from './lastProject';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

/**
 * «Разобрать…» (владелец 24.10.2026) — кнопка в заголовке «Предложить тикет»
 * и окно над всеми открытыми предложениями групп разом.
 *
 * «Опубликовать в Jira» — одно нажатие и есть согласие: сервер сводит
 * предложения моделью и сразу заводит задачи, правки черновиков нет. Окно
 * показывает итог — ключи ссылками, упавшие с причиной и «Повторить упавшие».
 * «Решить здесь» — Jira не нужна: один новый чат проекта с задачей из всех
 * открытых предложений; они отмечаются «взято в чат», окно уводит в этот чат.
 */
export function SplitTicketResolve({
  groups,
  parentChatId,
  onOpen,
  foreign = false,
}: SplitTicketResolveProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState('');
  const [pickedType, setPickedType] = useState('');
  const [result, setResult] = useState<SplitTicketPublished>();
  const [error, setError] = useState<string>();
  const [choices, setChoices] = useState<Record<string, SplitTicketDuplicateChoice>>({});
  // Решения первой публикации: «Повторить упавшие» шлёт их же — проверка к
  // тому времени уже не идёт, а «завести всё равно» не должно стать комментарием.
  const [sent, setSent] = useState<SplitTicketDuplicateDecision[]>([]);
  const [last] = useState(readLastProject);
  const target = useSplitTicketTarget({ parentChatId, project: picked, last }, open && !result);
  const publish = usePublishSplitTickets();
  const take = useTakeSplitTickets();
  const base = 'chat.cascade.hub.tickets.resolve';
  const lang = i18n.language.startsWith('en') ? 'en' : 'ru';

  const data = target.data;
  const project = picked || data?.projectKey || '';
  const canSearch = open && !result && Boolean(data?.connected) && !data?.messageCode;
  // Хук — до раннего выхода: порядок хуков не зависит от числа открытых.
  const similar = useSplitTicketDuplicates({ parentChatId, project }, canSearch);

  const clusters = clusterSplitTickets(openSplitTickets(groups));
  if (clusters.length === 0 && !open) return null;

  const types = data?.issueTypes ?? [];
  const issueType = types.includes(pickedType) ? pickedType : (data?.issueType ?? '');
  const duplicatesState = ((): DuplicatesState | undefined => {
    if (!canSearch || !project) return undefined;
    if (similar.data) return { state: 'ready', data: similar.data };
    if (similar.isError) return { state: 'error', message: toErrorMessage(similar.error) };
    return { state: 'loading' };
  })();
  const decisions = duplicateDecisions(similar.data?.duplicates ?? [], choices);
  const targetState = ((): TargetState => {
    if (data) return { state: 'ready', data };
    if (target.isError) return { state: 'error', message: toErrorMessage(target.error) };
    return { state: 'loading' };
  })();
  const offline = data?.connected === false;
  const publishBlocked = ((): string | undefined => {
    if (offline) return t(`${base}.offlineShort`);
    if (!data || !project || data.messageCode || data.projects.length === 0) {
      return t(`${base}.noTarget`);
    }
    if (clusters.length === 0) return t(`${base}.nothingOpen`);
    // Публикация до ответа проверки прошла бы без решений человека.
    if (duplicatesState?.state === 'loading') return t(`${base}.dupCheckingShort`);
    return undefined;
  })();

  const close = (): void => {
    setOpen(false);
    setResult(undefined);
    setError(undefined);
    setPicked('');
    setPickedType('');
    setChoices({});
    setSent([]);
    publish.reset();
    take.reset();
  };
  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: chatTreeKeys.all });

  const runPublish = (retryFailed: boolean): void => {
    if (publish.isPending || !project) return;
    setError(undefined);
    writeLastProject(project);
    const chosen = retryFailed ? sent : decisions;
    if (!retryFailed) setSent(decisions);
    publish.mutate(
      {
        parentChatId,
        projectKey: project,
        issueType: issueType || 'Bug',
        lang,
        retryFailed,
        ...(chosen.length > 0 ? { duplicates: chosen } : {}),
      },
      {
        onSuccess: (published) => {
          setResult(published);
          toast.success(t(`${base}.created`, { count: published.issues.length }));
          refresh();
        },
        onError: (failure) =>
          setError(t(`${base}.publishFailed`, { message: toErrorMessage(failure) })),
      },
    );
  };

  const runTake = (): void => {
    if (take.isPending || !onOpen) return;
    setError(undefined);
    take.mutate(
      { parentChatId, lang },
      {
        onSuccess: ({ chatId, count }) => {
          toast.success(t(`${base}.takenToast`, { count }));
          refresh();
          close();
          onOpen(chatId);
        },
        onError: (failure) =>
          setError(t(`${base}.takeFailed`, { message: toErrorMessage(failure) })),
      },
    );
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        title={t(`${base}.hint`)}
        data-resolve-tickets={clusters.length}
        onClick={() => setOpen(true)}
      >
        {t(`${base}.action`)}
      </Button>
      <Modal
        isOpen={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        title={t(`${base}.title`)}
        size="lg"
        footer={
          <SplitTicketResolveActions
            {...(publishBlocked ? { publishBlocked } : {})}
            publishing={publish.isPending}
            taking={take.isPending}
            canTake={!foreign && Boolean(onOpen) && clusters.length > 0}
            offline={offline}
            {...(result ? { result } : {})}
            onPublish={() => runPublish(false)}
            onRetry={() => runPublish(true)}
            onTake={runTake}
            onConnect={() => {
              close();
              void navigate({ to: SETTINGS_ROUTE, search: { tab: 'integrations' } } as never);
            }}
            onClose={close}
          />
        }
      >
        <SplitTicketResolveBody
          bundles={bundleSplitTickets(clusters)}
          target={targetState}
          project={project}
          issueType={issueType}
          onProject={(key) => {
            setPicked(key);
            setPickedType('');
            setChoices({});
          }}
          onIssueType={setPickedType}
          {...(result ? { result } : {})}
          {...(error ? { error } : {})}
          {...(duplicatesState ? { duplicates: duplicatesState } : {})}
          choices={choices}
          onChoice={(proposal, choice) =>
            setChoices((current) => ({ ...current, [proposal]: choice }))
          }
        />
      </Modal>
    </>
  );
}
