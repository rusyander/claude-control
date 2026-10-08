import type { ChatSummary } from '@agentdeck/contracts';
import { useTranslation } from 'react-i18next';
import { useWorkspace } from '@shared/lib/workspace';
import { useChats } from '../api/useChats';
import { useRef, useEffect } from 'react';
import { announceAwaiting } from './announceAwaiting';
import { useAwaitingChats } from './useAwaitingChats';

/**
 * Тот же список, но со звуком и тостом: сигнал раздаётся ОДИН раз на повод —
 * когда разговор впервые оказался ждущим. Первый снимок только запоминается:
 * панель открыли, а вопрос висит со вчера — звонить об этом значит приучить
 * человека не обращать внимания на звук.
 *
 * Скрытую вкладку зовёт ещё и уведомление системы (`announceAwaiting`).
 *
 * Тост здесь не украшение: метка в браузере говорит «тебя где-то ждут», но не
 * говорит ГДЕ, а точка видна только в уже открытом табе проекта. Клик по тосту
 * открывает нужный проект — иначе повод приходится искать руками по всей
 * истории.
 *
 * Монтируется единственный раз, на уровне приложения: два места вызова = два
 * звонка на один и тот же вопрос.
 */
export function useAwaitingAlarm(): ChatSummary[] {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const { data } = useChats();
  const awaiting = useAwaitingChats();
  const known = useRef<Set<string> | undefined>(undefined);

  useEffect(() => {
    if (!data) return;

    const ids = new Set(awaiting.map((chat) => chat.id));
    const seeded = known.current;
    known.current = ids;
    if (!seeded) return;

    const fresh = awaiting.filter((chat) => !seeded.has(chat.id));
    if (fresh.length === 0) return;

    announceAwaiting(fresh, { t, reveal: (path, name) => ws.reveal(path, name) });
    // `ws` меняется при каждом обновлении рабочего пространства, а повод —
    // только вместе со списком; лишняя зависимость звонила бы повторно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaiting, data, t]);

  return awaiting;
}
