import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useAwaitingChats, useChats } from '@entities/Chat';
import { useActiveRuns } from '@shared/lib/agent-runs';
import { useServerLink } from '@shared/lib/server-link';
import { workspace, projectShortName } from '@shared/lib/workspace';
import { pickTip, setMascotPrefs, tipScope, useMascotPrefs } from '@shared/lib/mascot';
import type { MascotMood } from '@shared/ui/mascot';
import { companionLists, runTarget } from '../model/chatTargets';
import { diffRuns, snapshotRuns } from '../model/runEvents';
import { resolveMood, statusLine } from '../model/mood';
import { shouldTip } from '../model/shouldTip';
import { EMPTY_MEMORY, pickReaction } from '../model/reactions';
import type { ReactionKind, ReactionMemory } from '../model/reactions.types';
import { useGroupEvents } from './useGroupEvents';
import type { ChatTarget } from '../model/chatTargets.types';
import type { RunSnapshot } from '../model/runEvents.types';
import { useActivity } from './useActivity';
import type { Speech, SpeechLine } from './useMascotCompanion.types';

/** Сколько висит реплика каждого рода, мс. Вопрос — дольше: работа стоит. */
const SPEECH_MS = {
  ask: 9_000,
  error: 8_000,
  done: 5_000,
  greet: 11_000,
  tip: 10_000,
  wake: 4_000,
  dizzy: 3_000,
  react: 9_000,
};

/**
 * «Связь пропала» висит дольше прочих реакций: пока связи нет, это главное, что
 * стоит знать о панели. Вернулась связь — фразу сменит «вернулась».
 */
const LINK_LOST_MS = 20_000;

/** Мимика реакции: беда — огорчение, остановка — раздумье, удача — радость. */
const REACTION_MOOD: Record<ReactionKind, MascotMood> = {
  linkLost: 'lost',
  linkBack: 'happy',
  runFailed: 'error',
  groupFailed: 'error',
  groupStopped: 'thinking',
  limitHit: 'waiting',
  longDone: 'happy',
  groupDelivered: 'happy',
};

/** Повод реакции: род, кого назвать и куда вести кнопкой. */
interface ReactionCause {
  kind: ReactionKind;
  name?: string;
  target?: ChatTarget;
}

/** Важность реплики: новая не перебивает более важную, что уже на экране. */
const PRIORITY = { ask: 5, error: 4, react: 4, done: 3, greet: 2, wake: 1, dizzy: 1, tip: 0 };

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
  const reactionMemory = useRef<ReactionMemory>(EMPTY_MEMORY);

  const render = useCallback(
    (line: SpeechLine): string => t(line.key, { name: line.name || t('mascot.panel.untitled') }),
    [t],
  );

  const say = useCallback(
    (kind: keyof typeof PRIORITY, line: SpeechLine, extra: Partial<Speech> = {}): void => {
      const current = speechRef.current;
      if (current && current.until > Date.now() && PRIORITY[current.kind] > PRIORITY[kind]) return;
      const next: Speech = {
        id: Date.now(),
        kind,
        text: render(line),
        line,
        until: Date.now() + SPEECH_MS[kind],
        ...extra,
      };
      speechRef.current = next;
      lastSpokeAt.current = Date.now();
      setSpeech(next);
    },
    [render],
  );

  const dismissSpeech = useCallback((): void => {
    speechRef.current = null;
    setSpeech(null);
  }, []);

  /**
   * Реакция на пачку событий: одна строка самого важного, без повтора прошлой
   * формулировки и не чаще срока (`pickReaction`). Сказала — `true`.
   */
  const react = useCallback(
    (causes: ReactionCause[]): boolean => {
      const pick = pickReaction(
        causes.map((cause) => cause.kind),
        reactionMemory.current,
        Date.now(),
      );
      if (!pick) return false;
      reactionMemory.current = pick.memory;
      const cause = causes.find((item) => item.kind === pick.kind);
      say(
        'react',
        { key: `mascot.react.${pick.kind}.${pick.variant}`, name: cause?.name },
        {
          reaction: pick.kind,
          mood: REACTION_MOOD[pick.kind],
          ...(cause?.target ? { target: cause.target } : {}),
          ...(pick.kind === 'linkLost' ? { until: Date.now() + LINK_LOST_MS } : {}),
        },
      );
      return true;
    },
    [say],
  );

  const flashMood = useCallback((mood: MascotMood): void => {
    const until = Date.now() + FLASH_MS;
    setFlash({ mood, until });
    setNow(Date.now());
  }, []);

  const { isAsleep, lastInputAt } = useActivity(counts.running === 0 && attention === 0, () => {
    if (prefs.enabled && prefs.chatty)
      say('wake', { key: 'mascot.speech.wake' }, { mood: 'waving' });
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
    const causes: ReactionCause[] = [];
    for (const event of events) {
      const target = runTarget(event, chatList);
      const named = Boolean(target.name);
      // Реакции включены — сбой, лимит и конец долгого хода идут одной пачкой
      // через `react`: одна строка на пачку, без повтора формулировки.
      if (prefs.reactions && event.kind === 'error') {
        causes.push({ kind: 'runFailed', name: target.name, target });
        continue;
      }
      if (event.kind === 'limit') {
        if (prefs.reactions) causes.push({ kind: 'limitHit', name: target.name, target });
        continue;
      }
      if (prefs.reactions && event.kind === 'done' && event.long) {
        flashMood('happy');
        causes.push({ kind: 'longDone', name: target.name, target });
        continue;
      }
      if (event.kind === 'ask') {
        say('ask', { key: 'mascot.speech.ask', name: target.name }, { target });
      } else if (event.kind === 'error') {
        say(
          'error',
          named
            ? { key: 'mascot.speech.error', name: target.name }
            : { key: 'mascot.speech.errorAnonymous' },
          { target },
        );
      } else {
        flashMood('happy');
        say(
          'done',
          named
            ? { key: 'mascot.speech.done', name: target.name }
            : { key: 'mascot.speech.doneAnonymous' },
          { target },
        );
      }
    }
    if (causes.length > 0) react(causes);
    // Реплики собираются из `t` и списка разговоров на момент события, а
    // пересчитывать их на каждое обновление списка не нужно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, prefs.enabled]);

  // Связь с сервером: пропала (поток не открылся за срок ожидания) и вернулась.
  // Вернулась — устаревшее «пропала» уходит со сцены, даже если «вернулась»
  // промолчит по сроку.
  const link = useServerLink();
  const previousLink = useRef(link);
  useEffect(() => {
    const before = previousLink.current;
    previousLink.current = link;
    if (before === link) return;
    if (link === 'up' && speechRef.current?.reaction === 'linkLost') dismissSpeech();
    if (!prefs.enabled || !prefs.reactions) return;
    if (link === 'down') react([{ kind: 'linkLost' }]);
    else if (link === 'up' && before === 'down') react([{ kind: 'linkBack' }]);
  }, [link, prefs.enabled, prefs.reactions, react, dismissSpeech]);

  // Группы разделения: упала, остановлена, доставлена. Кнопка ведёт в хаб —
  // разговор-корень дерева.
  useGroupEvents((events) => {
    if (!prefs.enabled || !prefs.reactions) return;
    react(
      events.map((event) => ({
        kind: event.kind,
        name: event.title,
        target: runTarget({ id: event.root }, chatList),
      })),
    );
  });

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
    say('ask', { key: 'mascot.speech.ask', name: target.name }, { target });
    // См. эффект прогонов выше: имя — на момент события.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaiting, chats, prefs.enabled]);

  // Первое знакомство — один раз на браузер.
  useEffect(() => {
    if (!prefs.enabled || prefs.greeted) return undefined;
    const timer = window.setTimeout(() => {
      setMascotPrefs({ greeted: true });
      say('greet', { key: 'mascot.speech.greet' }, { mood: 'waving' });
    }, GREET_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [prefs.enabled, prefs.greeted, say]);

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
      say('tip', { key: `mascot.tips.${key}` }, { mood: 'thinking' });
    }, TIP_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [prefs.enabled, lastInputAt, say]);

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
    say('dizzy', { key: 'mascot.speech.dizzy' });
  }, [flashMood, say]);

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
    // Текст — на языке этого рендера: `useTranslation` перерисовывает хук при
    // смене языка, и висящая реплика переходит на новый вместе со всей панелью.
    speech: speech?.line ? { ...speech, text: render(speech.line) } : speech,
    dismissSpeech,
    openChat,
    poke,
    tip,
    nextTip,
  };
}
