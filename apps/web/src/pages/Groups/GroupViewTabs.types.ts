export type GroupView = 'path' | 'members';

export interface GroupViewTabsProps {
  /** Префикс id вкладок и панелей — у каждого окна свой, иначе id повторились бы. */
  idBase: string;
  active: GroupView;
  onSelect: (view: GroupView) => void;
}
