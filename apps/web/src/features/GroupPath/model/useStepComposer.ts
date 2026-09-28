import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  LocalizedText,
  PathEntry,
  PathLang,
  PathStep,
  PathStepProposal,
} from '@agentdeck/contracts';
import type { AgentImage } from '@agentdeck/contracts/agent-images';
import { useDraftPathStep, usePromotePathStep, useSaveGroupPathSteps } from '@entities/Group';
import { customSteps, insertAfter, replaceStep, slotAfter, type PathSlot } from './pathEdit';
import { isBilingual, otherLang, stepFromProposal, withoutMatch } from './stepDraft';

/** Что делает окно: вставляет новый шаг после строки `index` или правит готовый. */
export type ComposerTarget = { kind: 'insert'; index: number } | { kind: 'edit'; step: PathStep };

export interface ComposerTurn {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  /** Имена картинок, ушедших с репликой человека. */
  images?: string[];
  proposal?: PathStepProposal;
}

type EditableField = 'title' | 'prompt' | 'gate';

const EMPTY_TEXT: LocalizedText = { ru: '', en: '' };

/**
 * Разговор окна «Новый шаг»: сырой текст → «Принять» → ассистент отвечает
 * предложением (с вопросами и похожими ресурсами) → человек отвечает или правит
 * одну сторону → «Подтвердить» сохраняет шаг → если ассистент предложил
 * сделать шаг ресурсом, окно спрашивает об этом последним.
 *
 * Состояние живёт только пока окно открыто: разговор нужен для одного шага,
 * а на сервере он продолжается по `conversationId`.
 */
export function useStepComposer({
  groupId,
  entries,
  target,
}: {
  groupId: string;
  entries: PathEntry[];
  target: ComposerTarget;
}) {
  const { i18n } = useTranslation();
  const uiLang: PathLang = i18n.language.startsWith('en') ? 'en' : 'ru';
  const existing = target.kind === 'edit' ? target.step : undefined;
  const slot: PathSlot = existing
    ? { anchor: existing.anchor, ...(existing.within ? { within: existing.within } : {}) }
    : slotAfter(entries, targetIndex(target));
  const { anchor, within } = slot;

  const [input, setInput] = useState(() => (existing ? existing.prompt[uiLang] : ''));
  const [turns, setTurns] = useState<ComposerTurn[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [proposal, setProposal] = useState<PathStepProposal | undefined>(() =>
    existing ? proposalOf(existing) : undefined,
  );
  const [lang, setLang] = useState<PathLang>(uiLang);
  /**
   * Стороны, правленые после последнего перевода, по порядку правки. Одной
   * стороны мало: правка RU, потом EN, и перевод EN молча затирал правку RU.
   * Перенесённый шаг («нужен перевод») перевода ещё не видел — его сторона-
   * источник считается правленой, иначе «Подтвердить» без правки снимал
   * пометку, а прогон читал русский текст как английский.
   */
  const [edits, setEdits] = useState<PathLang[]>(() =>
    existing?.needsTranslation ? [existing.source] : [],
  );
  const edited = edits.at(-1);
  /** Правлены обе стороны: перевод одной затёр бы правку другой — решает человек. */
  const bothEdited = edits.length > 1;
  const [phase, setPhase] = useState<'compose' | 'promote'>('compose');
  const [savedStepId, setSavedStepId] = useState<string | undefined>(undefined);
  /** Переводчик ответил без второй стороны — сохранять нечего, человек видит почему. */
  const [translationFailed, setTranslationFailed] = useState(false);
  // Найденный ассистентом ресурс — предложение, а не решение: человек может
  // оставить шаг своим текстом (прежде «Подтвердить» молча делал ссылку).
  const [keepText, setKeepText] = useState(false);

  const draft = useDraftPathStep(groupId);
  const save = useSaveGroupPathSteps(groupId);
  const promote = usePromotePathStep(groupId);

  /**
   * Поле пустеет сразу — как у чата; сбой ассистента возвращает набранное в
   * поле и снимает реплику из ленты: иначе человек набирал текст заново, а
   * повтор вставал в ленту вторым. `onAccepted` — только после ответа
   * (вложенные снимки убираются, когда их уже приняли).
   */
  const send = (
    text: string,
    images: readonly AgentImage[] = [],
    onAccepted?: () => void,
  ): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const turnId = `user-${turns.length}`;
    setTurns((list) => [
      ...list,
      {
        id: turnId,
        role: 'user',
        text: trimmed,
        ...(images.length > 0 ? { images: images.map((image) => image.name) } : {}),
      },
    ]);
    draft.mutate(
      {
        mode: 'author',
        text: trimmed,
        ...(images.length > 0 ? { images: [...images] } : {}),
        lang: uiLang,
        anchor,
        ...(within ? { within } : {}),
        ...(existing ? { stepId: existing.id } : {}),
        ...(conversationId ? { conversationId } : {}),
      },
      {
        onSuccess: (result) => {
          setConversationId(result.conversationId);
          setProposal(result.proposal);
          setEdits([]);
          setTurns((list) => [
            ...list,
            { id: `assistant-${list.length}`, role: 'assistant', proposal: result.proposal },
          ]);
          onAccepted?.();
        },
        onError: () => {
          setTurns((list) => list.filter((turn) => turn.id !== turnId));
          setInput((current) => current || trimmed);
        },
      },
    );
    setInput('');
  };

  const editField = (field: EditableField, side: PathLang, value: string): void => {
    setProposal((current) => {
      if (!current) return current;
      const base = field === 'gate' ? (current.gate ?? EMPTY_TEXT) : current[field];
      return { ...current, [field]: { ...base, [side]: value } };
    });
    setEdits((list) => [...list.filter((item) => item !== side), side]);
    setTranslationFailed(false);
  };

  /**
   * Перевод правленой стороны: ассистент в режиме `translate` получает шаг из
   * окна целиком (название, промпт, условие готовности) и отдаёт вторую
   * сторону. `then` получает уже переведённое предложение — «Подтвердить»
   * сохраняет именно его.
   */
  const translate = (
    then?: (translated: PathStepProposal) => void,
    from: PathLang | undefined = edited,
  ): void => {
    if (!proposal || !from) return;
    const current = proposal;
    draft.mutate(
      {
        mode: 'translate',
        text: current.prompt[from] || current.title[from],
        lang: from,
        anchor,
        ...(within ? { within } : {}),
        ...(existing ? { stepId: existing.id } : {}),
        ...(conversationId ? { conversationId } : {}),
        current: {
          title: current.title,
          prompt: current.prompt,
          ...(current.gate ? { gate: current.gate } : {}),
        },
      },
      {
        onSuccess: (result) => {
          const to = otherLang(from);
          const translated = mergeTranslation(current, result.proposal, to);
          setConversationId(result.conversationId);
          // Неполный перевод не принимаем: пустая сторона или потерянное
          // условие готовности оставили бы прогону старый английский текст.
          if (!isTranslated(translated, from)) {
            setTranslationFailed(true);
            return;
          }
          setTranslationFailed(false);
          setProposal(translated);
          setEdits([]);
          then?.(translated);
        },
      },
    );
  };

  const saveProposal = (
    ready: PathStepProposal,
    sourceLang: PathLang,
    onDone: () => void,
  ): void => {
    if (!isBilingual(ready)) return;
    // Место (стадию и `within`) ставят `insertAfter` / `replaceStep`, не шаг.
    const step = stepFromProposal(keepText ? withoutMatch(ready) : ready, {
      anchor,
      lang: sourceLang,
      existing,
      makeId: () => crypto.randomUUID(),
      now: new Date().toISOString(),
    });
    const steps = existing
      ? replaceStep(customSteps(entries), step)
      : insertAfter(entries, targetIndex(target), step);
    save.mutate(steps, {
      onSuccess: () => {
        // Предложение «сделать ресурсом» задаём ПОСЛЕ сохранения: повышают уже
        // существующий шаг, и отказ оставляет его обычным шагом пути.
        if (ready.promote && step.kind !== 'resource') {
          setSavedStepId(step.id);
          setPhase('promote');
          return;
        }
        onDone();
      },
    });
  };

  /**
   * Прогон читает только английскую сторону. Правленая сторона без перевода
   * сохранила бы шаг, где человек читает одно, а модель делает другое, —
   * поэтому «Подтвердить» сначала переводит, потом сохраняет перевод.
   */
  const confirm = (onDone: () => void): void => {
    if (!proposal || bothEdited) return;
    if (edited) {
      const from = edited;
      translate((translated) => saveProposal(translated, from, onDone));
      return;
    }
    saveProposal(proposal, uiLang, onDone);
  };

  const acceptPromotion = (onDone: () => void): void => {
    if (!proposal?.promote || !savedStepId) return onDone();
    promote.mutate(
      { stepId: savedStepId, type: proposal.promote.type, draft: proposal.promote.draft },
      { onSuccess: onDone },
    );
  };

  return {
    anchor,
    within,
    uiLang,
    isEdit: Boolean(existing),
    input,
    setInput,
    turns,
    proposal,
    lang,
    setLang,
    edited,
    bothEdited,
    /** Обе стороны правлены: перевести с выбранной человеком. */
    translateFrom: (from: PathLang): void => translate(undefined, from),
    /** Обе стороны правлены: оставить обе как написаны — перевода не будет. */
    keepBoth: (): void => setEdits([]),
    translationFailed,
    keepText,
    setKeepText,
    phase,
    draft,
    save,
    promote,
    send,
    editField,
    translate,
    confirm,
    acceptPromotion,
    canConfirm:
      !bothEdited &&
      Boolean(proposal && (edited ? proposal.prompt[edited].trim() : isBilingual(proposal))) &&
      !save.isPending &&
      !draft.isPending,
  };
}

/**
 * Ответ переводчика поверх шага из окна: берётся только вторая сторона.
 * Пустое название в ответе оставляет прежнее (название — подпись, не
 * инструкция); промпт и условие готовности берутся ТОЛЬКО из ответа — старый
 * текст второй стороны и есть то, от чего перевод спасает.
 */
export function mergeTranslation(
  current: PathStepProposal,
  answer: PathStepProposal,
  to: PathLang,
): PathStepProposal {
  return {
    ...current,
    title: { ...current.title, [to]: answer.title[to] || current.title[to] },
    prompt: { ...current.prompt, [to]: answer.prompt[to] ?? '' },
    ...(current.gate ? { gate: { ...current.gate, [to]: answer.gate?.[to] ?? '' } } : {}),
  };
}

/** Перевод полон: у второй стороны есть промпт и условие, если оно есть у правленой. */
export function isTranslated(proposal: PathStepProposal, from: PathLang): boolean {
  const to = otherLang(from);
  if (!proposal.prompt[to].trim()) return false;
  const gateFrom = proposal.gate?.[from].trim();
  return !gateFrom || Boolean(proposal.gate?.[to].trim());
}

function targetIndex(target: ComposerTarget): number {
  return target.kind === 'insert' ? target.index : -1;
}

/** Готовый шаг как «предложение», чтобы правка открывалась сразу с его текстом. */
function proposalOf(step: PathStep): PathStepProposal {
  return {
    similar: [],
    questions: [],
    title: step.title,
    prompt: step.prompt,
    ...(step.gate ? { gate: step.gate } : {}),
  };
}
