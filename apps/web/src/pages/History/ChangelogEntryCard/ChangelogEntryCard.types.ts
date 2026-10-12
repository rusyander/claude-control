import type { ChangelogEntry } from '@agentdeck/contracts/changelog';

export interface ChangelogEntryCardProps {
  entry: ChangelogEntry;
  isOpen: boolean;
  onToggle: () => void;
}
