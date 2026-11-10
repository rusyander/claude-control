import type { ProjectRunnerView } from '@agentdeck/contracts';
import type { SitePreviewProps } from '@features/SitePreview';
import type { ChatMediaApi } from '@entities/Media';
import type { DraftBox } from '@shared/lib/draft';
import type { ChatSendFile } from '../ChatPage.types';
import type { ChatSession } from '../model/useChatSession';

export interface SitePickOptions {
  /** Вкладка и разговор: каталог проекта, ключ разговора (сменился — чипы сняты), предпросмотр. */
  session: Pick<
    ChatSession,
    'projectPath' | 'isProjectContext' | 'activeChat' | 'draftKey' | 'setPreview'
  >;
  draft: DraftBox;
  /** Картинка и колода в столбце справа: показаны позже — окно сайта уступает им место. */
  media: Pick<ChatMediaApi, 'shownImage' | 'shownDeck' | 'close'>;
  /** Ход субагента в столбце справа — то же правило, что у картинки. */
  agentPane: unknown;
}

export interface SitePick {
  /** Работающая цель проекта с адресом: полоса «Сайт: имя» видна. */
  target?: ProjectRunnerView;
  /** Пропсы открытого окна сайта для столбца справа. */
  pane?: SitePreviewProps;
  isOpening: boolean;
  toggle: () => Promise<void>;
  close: () => void;
  /** Отправка поля ввода с блоками чипов поверх обычной отправки. */
  send: (
    files: ChatSendFile[],
    plain: (files: ChatSendFile[]) => Promise<boolean>,
  ) => Promise<boolean>;
}
