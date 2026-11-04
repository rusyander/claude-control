import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionStreamEvent } from '@agentdeck/contracts/core/session-stream';
import { STEP_MACHINE } from '@agentdeck/contracts/core/states';
import { useCoreTaskEvents, useCoreTaskView } from '@entities/CoreTask';
import { endCoreChat, sendChatTurn } from '../api/chatApi';
import { activeLaunchRefusal, launchRefusalOfEvent, type LaunchRefusal } from './chatRefusal';
import { chatItems, chatStepOf, modelTurnOpen, sessionsOfStep } from './chatView';
import type { ChatItem, SessionEvents } from './coreChat.types';
import { followSession, sessionStreamUrl } from './sessionFollow';

interface Followed {
  events: SessionStreamEvent[];
  done: boolean;
  dropped: boolean;
  refused: number | null;
}

export interface CoreChatState {
  items: ChatItem[];
  /** Сообщения человека, ушедшие в ядро и ещё не увиденные в потоке сеанса. */
  pending: string[];
  stepId: string | undefined;
  /** Шаг чата закрыт (`end-chat`, отмена) или задача кончилась. */
  closed: boolean;
  /** Модель ещё отвечает на последний ход. */
  answering: boolean;
  /** Поток оборвался и ждёт повтора. */
  dropped: boolean;
  refusal: number | null;
  /** Ядро отказало запуску CLI (суд совместимости), и сеанс после отказа не начался. */
  launchRefusal: LaunchRefusal | null;
  /** Шаг чата кончился неудачей без единого сеанса — причина ядра дословно. */
  failedReason: string | null;
  taskMissing: boolean;
  error: string | null;
  send(text: string): Promise<void>;
  end(): Promise<void>;
}

/**
 * Чат ядра по номеру задачи: вид задачи (лента журнала держит его свежим) даёт шаг чата и его
 * сеансы, поток вида каждого сеанса — события. После перезапуска панели страница открывается
 * заново и читает каждый сеанс с начала: ход, сказанный, пока панели не было, на месте.
 */
export function useCoreChat(taskId: string): CoreChatState {
  const { view, error: viewError } = useCoreTaskView(taskId);
  const [lastRefusal, setLastRefusal] = useState<LaunchRefusal | null>(null);
  // Лента задачи читается с начала: отказ, записанный до открытия страницы, тоже виден.
  const { refusal: eventsRefusal } = useCoreTaskEvents(taskId, (event) => {
    const got = launchRefusalOfEvent(event);
    if (got) setLastRefusal((prev) => (prev && prev.seq >= got.seq ? prev : got));
  });
  const [followed, setFollowed] = useState<Record<string, Followed>>({});
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const aborts = useRef(new Map<string, AbortController>());

  const step = chatStepOf(view);
  const sessions = useMemo(() => (step ? sessionsOfStep(view, step.stepId) : []), [view, step]);

  useEffect(() => {
    for (const s of sessions) {
      if (aborts.current.has(s.sessionId)) continue;
      const abort = new AbortController();
      aborts.current.set(s.sessionId, abort);
      // Новый читатель читает сеанс с начала: события снятого читателя (двойное монтирование
      // разработки) сбрасываются, иначе ход показался бы дважды.
      setFollowed((all) => ({
        ...all,
        [s.sessionId]: { events: [], done: false, dropped: false, refused: null },
      }));
      const patch = (p: Partial<Followed>) =>
        setFollowed((all) => {
          const prev = all[s.sessionId] ?? {
            events: [],
            done: false,
            dropped: false,
            refused: null,
          };
          return { ...all, [s.sessionId]: { ...prev, ...p } };
        });
      void followSession({
        url: sessionStreamUrl(taskId, s.sessionId),
        signal: abort.signal,
        onEvents: (events, done) =>
          setFollowed((all) => {
            const prev = all[s.sessionId] ?? {
              events: [],
              done: false,
              dropped: false,
              refused: null,
            };
            return {
              ...all,
              [s.sessionId]: {
                events: [...prev.events, ...events],
                done,
                dropped: false,
                refused: null,
              },
            };
          }),
        onDrop: () => patch({ dropped: true }),
        onRefusal: (status) => patch({ refused: status }),
      });
    }
  }, [sessions, taskId]);

  useEffect(() => {
    const map = aborts.current;
    setLastRefusal(null);
    return () => {
      for (const a of map.values()) a.abort();
      map.clear();
    };
  }, [taskId]);

  const items = useMemo(() => {
    const ordered: SessionEvents[] = sessions.map((s) => ({
      sessionId: s.sessionId,
      events: followed[s.sessionId]?.events ?? [],
      done: followed[s.sessionId]?.done ?? false,
    }));
    return chatItems(ordered);
  }, [sessions, followed]);

  // Ушедшее сообщение показано «в пути», пока сеанс не отдал его своим ходом.
  useEffect(() => {
    if (pending.length === 0) return;
    const seen = items
      .filter((i) => i.kind === 'human')
      .map((i) => (i.kind === 'human' ? i.text : ''));
    setPending((p) => p.filter((text) => !seen.includes(text)));
  }, [items, pending.length]);

  const closed =
    view?.ended != null ||
    (step !== undefined && (STEP_MACHINE.terminal as readonly string[]).includes(step.state));
  const states = Object.values(followed);
  const launchRefusal = activeLaunchRefusal(lastRefusal, sessions);
  const failedReason =
    step?.outcome === 'failed' && sessions.length === 0 ? (step.reason ?? '') : null;
  return {
    items,
    pending,
    stepId: step?.stepId,
    closed,
    answering: !closed && (modelTurnOpen(items) || pending.length > 0),
    dropped: states.some((f) => f.dropped && !f.done),
    refusal: eventsRefusal ?? states.find((f) => f.refused !== null)?.refused ?? null,
    launchRefusal,
    failedReason,
    taskMissing: viewError != null && view === undefined,
    error,
    async send(text) {
      const body = text.trim();
      if (!body || !step) return;
      setError(null);
      setPending((p) => [...p, body]);
      try {
        const out = await sendChatTurn(taskId, step.stepId, body);
        if (out.status !== 'applied')
          throw new Error(`${out.code ?? ''} ${out.reason ?? ''}`.trim());
      } catch (e) {
        setPending((p) => p.filter((x) => x !== body));
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    async end() {
      if (!step) return;
      setError(null);
      try {
        const out = await endCoreChat(taskId, step.stepId);
        if (out.status !== 'applied')
          throw new Error(`${out.code ?? ''} ${out.reason ?? ''}`.trim());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
