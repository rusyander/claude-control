import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MediaDeck, MediaImage } from '@agentdeck/contracts';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import {
  useCreateDeck,
  useCreateImage,
  useDeckPlan,
  useImagePlan,
  useMediaPrompt,
} from '../api/MediaApi';
import type { ComposerMode, ComposerModeState } from './composer-mode';
import { deckModeView, imageModeView } from './media-mode';
import { composerFlags, planMediaSubmit } from './media-submit';
import type { MediaRevision } from './revision';

export interface ChatMediaInput {
  /** Разговор, к которому привязать результат. Пусто — черновик без разговора. */
  chatId: string;
  /**
   * Послать сообщение агенту ЭТОГО разговора. Пусто — агента нет (черновик,
   * заблокированный чат), и тогда доступны только дороги, по которым панель ходит
   * сама. Через этот же шов дорога агента работает и у чужого CLI: у Claude сюда
   * приходит `dispatch` прогона, у провайдера — его `send`.
   */
  ask?: (text: string) => Promise<boolean> | boolean;
  /** Правый столбец один: открытый результат убирает предпросмотр артефакта. */
  closePreview?: () => void;
}

export interface ChatMediaApi {
  /** Состояние меню «Режим» для композера. */
  modes: ComposerModeState;
  /** Картинка, открытая в правом столбце. Пусто — столбец занят не ею. */
  shownImage?: MediaImage;
  /** Колода, которую собрала сама панель (дороги контура и эндпоинта). */
  shownDeck?: MediaDeck;
  close: () => void;
  /** Идёт ли неттекстовый режим: отправка тогда делает, а не пишет агенту. */
  isMediaMode: boolean;
  /** Выполнить режим по тексту из поля. Ложь — поле не очищать. */
  submit: (text: string) => Promise<boolean>;
  /** Правка готовой колоды — для карточек в ленте и в правом столбце. */
  revision: MediaRevision;
  /**
   * Тема, которую человек назвал последней. Ею подписывается карточка колоды из
   * блока: в самом блоке темы нет, а заголовок колоды придумала модель, и через
   * день по нему не понять, о чём просили.
   */
  topic?: string;
}

/**
 * Режимы «Картинка» и «Презентация» в чате — один хук на оба чата.
 *
 * ДВЕ РАЗНЫЕ ДОРОГИ, и разница видна человеку:
 *
 *  - панель делает САМА (контур, ручка картинок, свой эндпоинт). У результата
 *    свой файл и своя карточка в правом столбце, а в переписке его нет вовсе:
 *    расшифровка — файл Claude Code, и панель в него не пишет ни строки, иначе
 *    она подделывала бы чужую историю;
 *  - просит АГЕНТА разговора (дорога `agent`). Тогда панель отправляет обычное
 *    сообщение с готовой просьбой, а результат приезжает блоком в ответе и
 *    становится карточкой прямо в ленте. Этой дорогой режимы работают у любого
 *    CLI и без контура — ровно то, чего не хватало в Т9.
 *
 * Доступность спрашивается у сервера ДО нажатия: пункт обязан быть либо рабочим,
 * либо запертым с причиной. Считать её здесь во второй раз значило бы разойтись с
 * настоящим маршрутом — болезнь, которую в Т6 вылечил один общий `chooseRunModel`.
 */
export function useChatMedia({ chatId, ask, closePreview }: ChatMediaInput): ChatMediaApi {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ComposerMode>('text');
  const [shownImage, setShownImage] = useState<MediaImage>();
  const [shownDeck, setShownDeck] = useState<MediaDeck>();
  /** Колода, которую правит следующая отправка. Пусто — обычная сборка. */
  const [revising, setRevising] = useState<MediaDeck>();
  const [topic, setTopic] = useState<string>();

  // Признак разговора уезжает в план: с агентом рядом дорога есть всегда, и
  // сервер обязан считать доступность именно для этого места.
  const hasAgent = Boolean(ask);
  const imagePlan = useImagePlan(hasAgent);
  const deckPlan = useDeckPlan(hasAgent);
  const createImage = useCreateImage();
  const createDeck = useCreateDeck();
  const prompt = useMediaPrompt();

  // Что показать в меню, считают чистые функции: решение про слова доступности
  // проверяется тестом, а хук держит вокруг него только состояние.
  const image = imageModeView(imagePlan.data, t);
  const deck = deckModeView(deckPlan.data, t);

  const clearRight = (): void => {
    closePreview?.();
    setShownImage(undefined);
    setShownDeck(undefined);
  };

  /** Просьба агенту: текст собирает сервер, отправляет — страница своим путём. */
  const askAgent = async (
    kind: 'deck' | 'deck-revise' | 'picture',
    asked: string,
    reviseOf?: string,
  ): Promise<boolean> => {
    if (!ask) return false;
    const text = await prompt.mutateAsync({
      kind,
      topic: asked,
      ...(reviseOf ? { reviseOf } : {}),
    });
    return (await ask(text)) !== false;
  };

  const submit = async (text: string): Promise<boolean> => {
    const plans = {
      ...(imagePlan.data ? { image: imagePlan.data } : {}),
      ...(deckPlan.data ? { deck: deckPlan.data } : {}),
    };
    const action = planMediaSubmit(mode, text, plans, revising);
    if (!action) return false;
    setTopic(text.trim());

    try {
      if (action.road === 'agent') {
        // Состояние правки живёт до сборки файлов: блок придёт ответом позже, и
        // именно карточка в ленте должна знать, что колода — правка.
        return await askAgent(action.kind, action.topic, action.reviseOf);
      }
      if (action.road === 'image') {
        const created = await createImage.mutateAsync({ chatId, prompt: action.prompt });
        clearRight();
        setShownImage(created);
        return true;
      }
      const created = await createDeck.mutateAsync({
        chatId,
        prompt: action.prompt,
        ...(action.reviseOf ? { reviseOf: action.reviseOf } : {}),
      });
      clearRight();
      setShownDeck(created);
      setRevising(undefined);
      return true;
    } catch (error) {
      // Отказ говорится словами сервера: там названы и чужой ответ, и причина
      // недоступности. Поле не очищаем — описание переписывают, а не набирают
      // заново.
      toast.error(t('chat.mode.card.failed', { message: toErrorMessage(error) }));
      return false;
    }
  };

  return {
    modes: {
      mode,
      onModeChange: (next: ComposerMode) => {
        setMode(next);
        // Уход из режима презентации отменяет правку: иначе следующая колода по
        // новой теме молча заменила бы прежнюю.
        if (next !== 'deck') setRevising(undefined);
      },
      ...composerFlags({
        image,
        deck,
        plans: {
          ...(imagePlan.data ? { image: imagePlan.data } : {}),
          ...(deckPlan.data ? { deck: deckPlan.data } : {}),
        },
        isBusy: createImage.isPending || createDeck.isPending || prompt.isPending,
        ...(revising ? { revising } : {}),
      }),
      onReviseCancel: () => setRevising(undefined),
      // Открытие меню — единственный момент, когда план ТОЧНО нужен свежим:
      // дальше человек нажимает пункт. Сбрасывать ключ из каждой записи в
      // настройки, контур и профили эндпоинтов значило бы завести второй
      // список дорог, который однажды разойдётся с настоящим.
      onMenuOpen: () => {
        void imagePlan.refetch();
        void deckPlan.refetch();
      },
    },
    ...(shownImage ? { shownImage } : {}),
    ...(shownDeck ? { shownDeck } : {}),
    close: () => {
      setShownImage(undefined);
      setShownDeck(undefined);
    },
    revision: {
      ...(revising ? { reviseOf: revising.id } : {}),
      onStart: (target: MediaDeck) => {
        setRevising(target);
        setMode('deck');
      },
      onDone: () => setRevising(undefined),
    },
    ...(topic ? { topic } : {}),
    isMediaMode: mode !== 'text',
    submit,
  };
}
