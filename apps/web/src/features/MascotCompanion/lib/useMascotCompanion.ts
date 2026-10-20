import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useAwaitingChats, useChats } from '@entities/Chat';
import { useActiveRuns } from '@shared/lib/agent-runs';
import { workspace, projectShortName } from '@shared/lib/workspace';
import { pickTip, setMascotPrefs, tipScope, useMascotPrefs } from '@shared/lib/mascot';
import type { MascotMood } from '@shared/ui/mascot';
import { companionLists, runTarget } from '../model/chatTargets';
import { diffRuns, snapshotRuns } from '../model/runEvents';
import { resolveMood, statusLine } from '../model/mood';
import { shouldTip } from '../model/shouldTip';
import type { ChatTarget } from '../model/chatTargets.types';
import type { RunSnapshot } from '../model/runEvents.types';
import { useActivity } from './useActivity';
import type { Speech } from './useMascotCompanion.types';

/** Сколько висит реплика каждого рода, мс. Вопрос — дольше: работа стоит. */
const SPEECH_MS = {
  ask: 9_000,
  error: 8_000,
  done: 5_000,
  greet: 11_000,
  tip: 10_000,
  wake: 4_000,
  dizzy: 3_000,
};

/** Важность реплики: новая не перебивает более важную, что уже на экране. */
const PRIORITY = { ask: 5, error: 4, done: 3, greet: 2, wake: 1, dizzy: 1, tip: 0 };

/** Радость от готового хода и головокружение — вспышки на столько, мс. */
const FLASH_MS = 3_200;

/** Приветствие звучит не сразу: сначала панель должна открыться. */
const GREET_AFTER_MS = 2_500;

/** Как часто спрашивать «не пора ли совет». */
const TIP_CHECK_MS = 30_000;

/**
 * Всё, что делает Дека в боковой панели: настроение из прогонов агентов и
 * ждущих разговоров, реплики на события (вопрос, ошибка, готовый ход), советы
 * по своей инициативе и сон, когда человек отошёл.
 */
export function useMascotCompanion(isPanelOpen: boolean) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const prefs = useMascotPrefs();
  const runs = useActiveRuns();
  const awaiting = useAwaitingChats();
  const { data: chats } = useChats();
  const chatList = useMemo(() => chats ?? [], [chats]);

  const lists = useMemo(() => companionLists(runs, awaiting, chatList), [runs, awaiting, chatList]);
  const counts = {
    waiting: lists.waiting.length,
    errors: lists.errors.length,
    running: lists.running.length,
  };
  const attention = counts.waiting + counts.errors;

  const [speech, setSpeech] = useState<Speech | null>(null);
  const [flash, setFlash] = useState<{ mood: MascotMood; until: number } | null>(null);
  const [tip, setTip] = useState(() => pickTip(tipScope(pathname)));
  const [now, setNow] = useState(() => Date.now());
  const speechRef = useRef<Speech | null>(null);
  const lastSpokeAt = useRef<number | undefined>(undefined);
  const mountedAt = useRef(Date.now());
  const snapshot = useRef<RunSnapshot | undefined>(undefined);

  const say = useCallback(
    (kind: keyof typeof PRIORITY, text: string, extra: Partial<Speech> = {}): void => {
      const current = speechRef.current;
      if (current && current.until > Date.now() && PRIORITY[current.kind] > PRIORITY[kind]) return;
      const next: Speech = {
        id: Date.now(),
        kind,
        text,
        until: Date.now() + SPEECH_MS[kind],
        ...extra,
      };
      speechRef.current = next;
      lastSpokeAt.current = Date.now();
      setSpeech(next);
    },
    [],
  );

  const dismissSpeech = useCallback((): void => {
    speechRef.current = null;
    setSpeech(null);
  }, []);

  const flashMood = useCallback((mood: MascotMood): void => {
    const until = Date.now() + FLASH_MS;
    setFlash({ mood, until });
    setNow(Date.now());
  }, []);

  const { isAsleep, lastInputAt } = useActivity(counts.running === 0 && attention === 0, () => {
    if (prefs.enabled && prefs.chatty) say('wake', t('mascot.speech.wake'), { mood: 'waving' });
  });

  // Реплика сама уходит со сцены, вспышка гаснет — по своим часам.
  useEffect(() => {
    if (!speech) return undefined;
    const timer = window.setTimeout(dismissSpeech, Math.max(0, speech.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [speech, dismissSpeech]);

  useEffect(() => {
    if (!flash) return undefined;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, flash.until - Date.now()) + 20,
    );
    return () => window.clearTimeout(timer);
  }, [flash]);

  // События прогонов → реплики. Ссылка на снимок обновляется каждый раз, даже
  // когда маскот выключен: включили — и он не «празднует» всё, что было до того.
  useEffect(() => {
    const events = diffRuns(snapshot.current, runs);
    snapshot.current = snapshotRuns(runs);
    if (!prefs.enabled) return;
    for (const event of events) {
      const target = runTarget(event, chatList);
      const named = Boolean(target.name);
      if (event.kind === 'ask') {
        say('ask', t('mascot.speech.ask', { name: target.name || t('mascot.panel.untitled') }), {
          target,
        });
      } else if (event.kind === 'error') {
        say(
          'error',
          named
            ? t('mascot.speech.error', { name: target.name })
            : t('mascot.speech.errorAnonymous'),
          {
            target,
          },
        );
      } else {
        flashMood('happy');
        say(
          'done',
          named ? t('mascot.speech.done', { name: target.name }) : t('mascot.speech.doneAnonymous'),
          {
            target,
          },
        );
      }
    }
    // Реплики собираются из `t` и списка разговоров на момент события, а
    // пересчитывать их на каждое обновление списка не нужно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, prefs.enabled]);

  // Разговор, ждущий вне прогонов панели (терминал, соседнее окно, вопрос
  // дерева), — тот же повод «ждёт ответа». Как у звонка: первый снимок только
  // запоминается, вопрос со вчерашнего дня не повод заговорить.
  const seenAwaiting = useRef<Set<string> | undefined>(undefined);
  useEffect(() => {
    if (!chats) return;
    const seen = seenAwaiting.current;
    seenAwaiting.current = new Set(awaiting.map((chat) => chat.id));
    if (!seen || !prefs.enabled) return;
    const fresh = awaiting.find((chat) => !seen.has(chat.id));
    if (!fresh) return;
    const target = runTarget({ id: fresh.id, projectPath: fresh.projectPath }, chatList);
    say('ask', t('mascot.speech.ask', { name: target.name || t('mascot.panel.untitled') }), {
      target,
    });
    // См. эффект прогонов выше: текст — на момент события.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaiting, chats, prefs.enabled]);

  // Первое знакомство — один раз на браузер.
  useEffect(() => {
    if (!prefs.enabled || prefs.greeted) return undefined;
    const timer = window.setTimeout(() => {
      setMascotPrefs({ greeted: true });
      say('greet', t('mascot.speech.greet'), { mood: 'waving' });
    }, GREET_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [prefs.enabled, prefs.greeted, say, t]);

  // Совет по своей инициативе — редко и только когда не мешает (`shouldTip`).
  const gateRef = useRef({ attention, isAsleep, isPanelOpen, chatty: prefs.chatty, pathname });
  gateRef.current = { attention, isAsleep, isPanelOpen, chatty: prefs.chatty, pathname };
  useEffect(() => {
    if (!prefs.enabled) return undefined;
    const timer = window.setInterval(() => {
      const gate = gateRef.current;
      const ready = shouldTip({
        now: Date.now(),
        mountedAt: mountedAt.current,
        lastSpokeAt: lastSpokeAt.current,
        lastInputAt: lastInputAt.current,
        chatty: gate.chatty,
        hidden: document.visibilityState === 'hidden',
        asleep: gate.isAsleep,
        panelOpen: gate.isPanelOpen,
        speaking: Boolean(speechRef.current && speechRef.current.until > Date.now()),
        attention: gate.attention,
      });
      if (!ready) return;
      const key = pickTip(tipScope(gate.pathname));
      say('tip', t(`mascot.tips.${key}`), { mood: 'thinking' });
    }, TIP_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [prefs.enabled, lastInputAt, say, t]);

  const openChat = useCallback(
    (target: ChatTarget): void => {
      if (target.projectPath && !target.isSandbox) {
        workspace.reveal(target.projectPath, projectShortName(target.projectPath));
      }
      void navigate({ to: '/chat', search: { id: target.chatId } } as never);
    },
    [navigate],
  );

  const poke = useCallback((): void => {
    flashMood('dizzy');
    say('dizzy', t('mascot.speech.dizzy'));
  }, [flashMood, say, t]);

  const nextTip = useCallback(
    () => setTip((current) => pickTip(tipScope(pathname), current)),
    [pathname],
  );

  const mood = resolveMood({
    ...counts,
    asleep: isAsleep,
    flash: flash ?? undefined,
    speechMood: speech?.mood,
    now: Math.max(now, Date.now()),
  });

  return {
    prefs,
    mood,
    status: statusLine({ ...counts, asleep: isAsleep }),
    lists,
    speech,
    dismissSpeech,
    openChat,
    poke,
    tip,
    nextTip,
  };
}
