import type { PanelAgentView } from './PanelAgentWindow.types';

export const VIEWS: PanelAgentView[] = ['conversation', 'history', 'journal'];

export const SLIDE = {
  hidden: { opacity: 0, x: 24 },
  visible: { opacity: 1, x: 0 },
};
