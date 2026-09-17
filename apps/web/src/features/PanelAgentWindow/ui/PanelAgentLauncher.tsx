import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import {
  buildPageContext,
  isPreviewTruncatedRefusal,
  isSecretAnchor,
  pageNavigation,
  sectionLabelKey,
  useDecidePanelAction,
  usePanelAgentEvents,
  usePanelAgentPending,
  withPending,
  withoutPending,
} from '@entities/PanelAgent';
import { fetchProjectRegistry } from '@entities/Project';
import { queryKeys } from '@shared/api/query-keys';
import { toErrorMessage } from '@shared/api/client';
import { useWorkspace } from '@shared/lib/workspace';
import { Icon } from '@shared/ui/icon';
import { usePanelAgentSession } from '../model/usePanelAgentSession';
import { focusAnchor, focusWindow, isFocusFree, watchTyping } from '../model/focusAnchor';
import { actionTitle } from '../model/actionTitle';
import { sectionQueryKeys } from '../model/sectionKeys';
import { PanelAgentWindow } from './PanelAgentWindow';
import type { PanelAgentLauncherProps } from './PanelAgentLauncher.types';
import styles from './PanelAgent.module.scss';

/**
 * Точка входа агента панели: строка в боковой панели на каждой странице и окно
 * у правого края. Здесь, а не в окне, живут разговор и подписка на кадры: окно
 * человек закрывает и открывает, а ход агента и карточка, пришедшая при
 * закрытом окне, от этого не зависят — карточка открывает окно сама, агент
 * стоит, пока человек не решит.
 */
export function PanelAgentLauncher({ isCollapsed = false }: PanelAgentLauncherProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useRouterState({ select: (state) => state.location });
  const { activeProject, openProject } = useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const panelRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Ожидание якоря открытой агентом страницы. `returnToWindow` — фокус уже
  // стоит в якоре, и Escape на странице возвращает человека в окно, откуда его
  // увели; взводится только переходом агента, не собственным кликом человека.
  const agentFocusRef = useRef<{ route: string; cancel: () => void; returnToWindow: boolean }>(
    undefined,
  );
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(new Set());
  const [decideErrors, setDecideErrors] = useState<Record<string, string>>({});
  const [approveRefused, setApproveRefused] = useState<ReadonlySet<string>>(new Set());

  const texts = useMemo(
    () => ({
      stopped: t('panelAgent.stopped'),
      runFailed: (message: string) => t('panelAgent.runFailed', { message }),
      refusal: (code: string) =>
        i18n.exists(`panelAgent.refusal.${code}`) ? t(`panelAgent.refusal.${code}`) : undefined,
    }),
    [t, i18n],
  );
  const session = usePanelAgentSession(texts);
  const { data: pending = [] } = usePanelAgentPending();
  const decide = useDecidePanelAction();

  const actionMessageText = (code: string | undefined): string | undefined => {
    const key = `panelAgent.messageCode.${code}`;
    return code && i18n.exists(key) ? t(key) : undefined;
  };

  const labelKey = sectionLabelKey(location.pathname);
  const pageLabel = labelKey ? t(labelKey) : location.pathname;

  const setPending = (update: (list: PanelPendingAction[] | undefined) => PanelPendingAction[]) =>
    queryClient.setQueryData<PanelPendingAction[]>(queryKeys.panelAgentPending, update);

  const dropDeciding = (id: string): void =>
    setDeciding((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });

  usePanelAgentEvents((event) => {
    if (event.type === 'agent-pending') {
      setPending((list) => withPending(list, event.pending));
      setIsOpen(true);
      return;
    }
    if (event.type === 'agent-decided') {
      const card = queryClient
        .getQueryData<PanelPendingAction[]>(queryKeys.panelAgentPending)
        ?.find((item) => item.id === event.id);
      setPending((list) => withoutPending(list, event.id));
      dropDeciding(event.id);
      // Причина исхода по коду (`stale_preview`): одобренное не выполнено, и
      // строка «ошибка маршрута» рядом с причиной отправила бы человека искать
      // поломку панели — показываем только причину.
      const reason = actionMessageText(event.messageCode);
      if (reason) session.note(reason, 'error');
      else if (card) {
        session.note(
          t('panelAgent.decidedLine', {
            name: actionTitle(card.name, t, (key) => i18n.exists(key)),
            outcome: t(`panelAgent.outcome.${event.outcome}`),
          }),
        );
      }
      // Правка агента прошла — открытая страница перечитывает свой раздел.
      // Наблюдатель файлов видит не всякую запись (реестр проектов, контур), и
      // без этого страница стояла бы на старом снимке до F5.
      if (event.outcome === 'done' || event.outcome === 'needs-secret') {
        for (const queryKey of sectionQueryKeys(event.section)) {
          void queryClient.invalidateQueries({ queryKey });
        }
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.panelAgentJournal });
      return;
    }
    // Открыть страницу: окно остаётся рядом — затемнения нет, страница живая,
    // разговор идёт дальше. `focus` у чата и тестов — часть адреса (`?id=`,
    // `?tab=`), у прочих — якорь, и фокус уходит в него, когда страница его
    // дорисует. Прежнее ожидание снимается: следующий переход главнее.
    const target = pageNavigation(event.page);
    agentFocusRef.current?.cancel();
    agentFocusRef.current = undefined;
    if (target.project) {
      // Проект чата — вкладка рабочего места: сначала открываем её, потом чат,
      // и страница чата сама заводит черновик нового разговора в этом проекте.
      const projectId = target.project;
      void queryClient
        // Свежий список, не кеш: проект только что создан агентом, и снимок
        // реестра, взятый до этого, его не знает.
        .fetchQuery({ queryKey: queryKeys.projects, queryFn: fetchProjectRegistry, staleTime: 0 })
        .then((projects) => {
          const project = projects.find((item) => item.id === projectId);
          if (project) openProject(project.path, project.name);
        })
        .catch(() => undefined)
        .finally(() => void navigate({ to: target.to, search: target.search } as never));
    } else {
      void navigate({ to: target.to, search: target.search } as never);
    }
    session.note(t('panelAgent.openedPage', { route: event.page.route }));
    if (target.anchor) {
      const watch: { route: string; cancel: () => void; returnToWindow: boolean } = {
        route: target.to,
        cancel: () => undefined,
        returnToWindow: false,
      };
      // «Поле ключа открыто» — только когда поле действительно нашлось на
      // странице: строка итога сама этого не утверждает.
      const secret = isSecretAnchor(target.anchor);
      watch.cancel = focusAnchor(
        target.anchor,
        () => {
          watch.returnToWindow = true;
        },
        secret ? () => session.note(t('panelAgent.secretFieldShown')) : undefined,
      );
      agentFocusRef.current = watch;
    }
  });

  // Человек сам ушёл на другую страницу — ждать якоря прежней больше незачем,
  // иначе фокус прыгнул бы в поле страницы, которой на экране уже нет.
  useEffect(() => {
    const watch = agentFocusRef.current;
    if (watch && watch.route !== location.pathname) {
      watch.cancel();
      agentFocusRef.current = undefined;
    }
  }, [location.pathname]);

  useEffect(() => () => agentFocusRef.current?.cancel(), []);

  // Кто печатает, тому фокус не переносят ни карточка, ни открытая агентом
  // страница: слушаем клавиатуру всего документа, пока окно смонтировано.
  useEffect(() => watchTyping(), []);

  // Открытое окно сдвигает страницу (CSS решает, на широком ли экране): метка на
  // корне, а не проп в раскладку — каркас не знает про окно агента.
  useEffect(() => {
    const root = document.documentElement;
    if (isOpen) root.setAttribute('data-panel-agent-docked', '');
    else root.removeAttribute('data-panel-agent-docked');
    return () => root.removeAttribute('data-panel-agent-docked');
  }, [isOpen]);

  const closeWindow = (): void => {
    setIsOpen(false);
    if (agentFocusRef.current) agentFocusRef.current.returnToWindow = false;
    // Фокус был в окне — возвращаем на кнопку, откуда в окно приходят. Стоял на
    // странице — не трогаем.
    if (isFocusFree()) triggerRef.current?.focus();
  };

  // Escape на странице, пока окно открыто. Фокус потерян (карточку сняли, узел
  // исчез) — закрывает окно, как Escape в нём. Фокус в якоре, куда его увёл
  // агент, — возвращает в окно. Обработчики страницы идут первыми: Escape,
  // которым страница уже распорядилась, или внутри её модального окна не наш.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const panel = panelRef.current;
      const target = event.target instanceof Element ? event.target : null;
      if (!panel || (target && panel.contains(target))) return;
      if (!target || target === document.body) {
        event.preventDefault();
        closeWindow();
        return;
      }
      const watch = agentFocusRef.current;
      if (!watch?.returnToWindow || target.closest('[role="dialog"]')) return;
      event.preventDefault();
      watch.returnToWindow = false;
      focusWindow(panel);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  const onDecide = (id: string, decision: 'approve' | 'reject'): void => {
    setDeciding((current) => new Set(current).add(id));
    setDecideErrors(({ [id]: _dropped, ...rest }) => rest);
    decide.mutate(
      { id, decision },
      {
        onError: (error) => {
          dropDeciding(id);
          if (decision === 'approve' && isPreviewTruncatedRefusal(error)) {
            setApproveRefused((current) => new Set(current).add(id));
          }
          setDecideErrors((current) => ({ ...current, [id]: toErrorMessage(error) }));
          // 404/409: карточка уже решена или снята — список с сервера скажет правду.
          void queryClient.invalidateQueries({ queryKey: queryKeys.panelAgentPending });
        },
      },
    );
  };

  const onSend = (text: string): void => {
    void session.send(
      text,
      buildPageContext({
        pathname: location.pathname,
        searchStr: location.searchStr,
        title: labelKey ? t(labelKey) : undefined,
        projectPath: activeProject?.path,
      }),
    );
  };

  // Кнопка не переключает окно, а ведёт в него: открытое окно рядом со
  // страницей закрывают крестиком или Escape, а сюда жмут, чтобы вернуться.
  const openWindow = (): void => {
    setIsOpen(true);
    setFocusRequest((current) => current + 1);
    // Кадр мог пройти мимо, пока связи не было: при открытии список перечитывается.
    void queryClient.invalidateQueries({ queryKey: queryKeys.panelAgentPending });
  };

  const title = t('panelAgent.open');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={openWindow}
        title={isCollapsed ? title : undefined}
        aria-label={
          pending.length > 0
            ? `${title}. ${t('panelAgent.pendingBadge', { count: pending.length })}`
            : title
        }
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        data-panel-agent-trigger
      >
        <span className={styles.iconWrap}>
          <Icon name="commands" size={24} />
          {pending.length > 0 && (
            <span className={styles.badge} aria-hidden="true">
              {pending.length > 9 ? '9+' : pending.length}
            </span>
          )}
          {session.state.running && <span className={styles.runningDot} aria-hidden="true" />}
        </span>
        <span className={styles.label}>{title}</span>
      </button>
      <span className={styles.srOnly} role="status">
        {pending.length > 0 ? t('panelAgent.pendingBadge', { count: pending.length }) : ''}
      </span>

      <PanelAgentWindow
        isOpen={isOpen}
        onClose={closeWindow}
        focusRequest={focusRequest}
        panelRef={panelRef}
        session={session}
        pending={pending}
        deciding={deciding}
        decideErrors={decideErrors}
        approveRefused={approveRefused}
        onDecide={onDecide}
        pageLabel={pageLabel}
        projectLabel={activeProject?.name}
        onSend={onSend}
      />
    </>
  );
}
