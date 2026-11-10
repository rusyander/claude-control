export { SitePreviewPane } from './ui/SitePreview/SitePreview';
export type { SitePreviewProps } from './ui/SitePreview/SitePreview.types';
// Полоса «Сайт: имя» над лентой: открыть окно сайта запущенной цели проекта.
export { SiteOpenButton } from './ui/SiteOpenButton/SiteOpenButton';
// Состояние окна: какую цель открыть, открытое окно, выбор на маскировку серверу.
export { useSitePreview } from './model/useSitePreview';
export type { SitePreviewState } from './model/useSitePreview.types';
// Чип и блок агенту из выбранного элемента — страница кладёт их в ввод чата.
export { describePick } from './lib/pickBlock';
