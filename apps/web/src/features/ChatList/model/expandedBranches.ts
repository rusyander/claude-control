import { useCallback, useState } from 'react';
import { readExpandedBranches } from '../lib/readExpandedBranches';
import { writeExpandedBranches } from '../lib/writeExpandedBranches';

/** Раскрыта ли ветвь — и переключатель, который сразу пишет память. */
export function useExpandedBranches(): {
  expanded: ReadonlySet<string>;
  toggle: (parentId: string) => void;
} {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(readExpandedBranches);
  const toggle = useCallback((parentId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      writeExpandedBranches(next);
      return next;
    });
  }, []);
  return { expanded, toggle };
}
