import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PickPayload } from '@agentdeck/contracts/site-preview';
import { describePick, useSitePreview, type SitePreviewProps } from '@features/SitePreview';
import { composerChips } from '@features/ChatComposer';
import { closeAgentPane } from '@entities/AgentTree';
import type { ChatSendFile } from '../ChatPage.types';
import { sendWithChips } from './sendWithChips';
import type { SitePick, SitePickOptions } from './useSitePick.types';

/**
 * Окно сайта и выбор элемента на странице чата (этап 12, V2): полоса «Сайт: имя», окно справа,
 * выбранный элемент — чипом в поле ввода, блоком агенту при отправке. Столбец справа один:
 * открытое окно сайта закрывает остальное, а показанные позже картинка, колода, ход субагента
 * или артефакт закрывают его. Чипы принадлежат разговору: сменился разговор или проект — сняты.
 */
export function useSitePick({ session, draft, media, agentPane }: SitePickOptions): SitePick {
  const { t } = useTranslation();
  const projectPath = session.isProjectContext ? session.projectPath : undefined;
  const chatKey = session.activeChat?.id ?? session.draftKey;
  const site = useSitePreview(projectPath);
  const { open, close, pick } = site;
  const othersShown = Boolean(media.shownImage ?? media.shownDeck ?? agentPane);

  useEffect(() => composerChips.clear(), [chatKey, projectPath]);
  useEffect(() => {
    if (othersShown) close();
  }, [othersShown, close]);

  const { setPreview } = session;
  const closeMedia = media.close;
  const toggle = useCallback(async () => {
    if (site.preview) {
      close();
      return;
    }
    if (!(await open())) return;
    closeMedia();
    closeAgentPane(false);
    setPreview(undefined);
  }, [site.preview, open, close, closeMedia, setPreview]);

  const onPick = useCallback(
    async (raw: PickPayload) => {
      const masked = await pick(raw);
      if (!masked) return;
      const chip = describePick(masked, {
        header: t('sitePreview.block.header'),
        url: t('sitePreview.block.url'),
        selector: t('sitePreview.block.selector'),
        tag: t('sitePreview.block.tag'),
        text: t('sitePreview.block.text'),
        rect: t('sitePreview.block.rect'),
        html: t('sitePreview.block.html'),
        empty: t('sitePreview.block.empty'),
      });
      composerChips.add({ id: `${masked.url} ${masked.selector}`, ...chip });
    },
    [pick, t],
  );

  const pane: SitePreviewProps | undefined = useMemo(
    () =>
      site.preview
        ? {
            preview: site.preview,
            onPick: (raw) => void onPick(raw),
            onClose: close,
            ...(site.name ? { name: site.name } : {}),
            ...(site.siteUrl ? { siteUrl: site.siteUrl } : {}),
          }
        : undefined,
    [site.preview, site.name, site.siteUrl, onPick, close],
  );

  const send = useCallback(
    (files: ChatSendFile[], plain: (files: ChatSendFile[]) => Promise<boolean>) =>
      sendWithChips(draft, files, plain, composerChips),
    [draft],
  );

  return {
    ...(site.target ? { target: site.target } : {}),
    ...(pane ? { pane } : {}),
    isOpening: site.isOpening,
    toggle,
    close,
    send,
  };
}
