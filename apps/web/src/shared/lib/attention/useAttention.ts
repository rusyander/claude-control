import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useActiveRuns } from '@shared/lib/agent-runs';
import { forgetSeen, getSeen, markSeen, subscribeSeen } from './attentionStore';
import {
  attentionReasons,
  attentionTitle,
  isLookingAt,
  quietRunIds,
  runKeyPrefix,
  selectAttention,
  type AttentionView,
  type AwaitingMark,
} from './attention';
import { applyFaviconBadge } from './favicon';

/**
 * Метка в самом браузере: точка на значке вкладки и счёт в её заголовке — только
 * за НЕУВИДЕННЫЕ поводы (правило — `attention.ts`). Ставится на уровне
 * приложения, а не страницы чата: уйти в «Настройки» и не узнать, что агент
 * спросил, было бы худшим из исходов.
 *
 * `awaiting` — разговоры, стоящие на вопросе по данным транскрипта и сервера:
 * их считает вызывающий (список чатов живёт слоем выше).
 */
export function useAttentionBadge(awaiting: readonly AwaitingMark[] = []): AttentionView {
  const runs = useActiveRuns();
  const seen = useSyncExternalStore(subscribeSeen, getSeen, getSeen);
  const reasons = useMemo(() => attentionReasons(runs, awaiting), [runs, awaiting]);

  // Прогон снова работает — его прошлый увиденный повод забыт, следующий зовёт.
  useEffect(() => {
    forgetSeen(quietRunIds(runs).map(runKeyPrefix));
  }, [runs]);

  // Человек смотрит на панель — всё, что сейчас зовёт, увидено. И сразу, и по
  // возврату фокуса или вкладки.
  useEffect(() => {
    const look = (): void => {
      if (isLookingAt(document)) markSeen(reasons.map((reason) => reason.key));
    };
    look();
    window.addEventListener('focus', look);
    document.addEventListener('visibilitychange', look);
    return () => {
      window.removeEventListener('focus', look);
      document.removeEventListener('visibilitychange', look);
    };
  }, [reasons]);

  const view = useMemo(() => selectAttention(reasons, seen), [reasons, seen]);

  useEffect(() => {
    // Исходный заголовок запоминаем один раз: иначе после первой же метки
    // «базой» станет уже помеченный текст и точки начнут копиться.
    document.title = attentionTitle(baseTitle(), view.count);
    applyFaviconBadge(view.tone);
  }, [view.count, view.tone]);

  return view;
}

let remembered: string | undefined;

function baseTitle(): string {
  remembered ??= document.title;
  return remembered;
}
