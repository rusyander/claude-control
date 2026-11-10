import { SiteOpenButton } from '@features/SitePreview';
import type { SitePick } from './useSitePick.types';

/** Полоса «Сайт: имя» над лентой — только пока сайт проекта запущен панелью и назвал адрес. */
export function ChatSiteStrip({ site }: { site: SitePick }) {
  if (!site.target?.url) return null;
  return (
    <SiteOpenButton
      name={site.target.name}
      url={site.target.url}
      isOpen={Boolean(site.pane)}
      isOpening={site.isOpening}
      onToggle={() => void site.toggle()}
    />
  );
}
