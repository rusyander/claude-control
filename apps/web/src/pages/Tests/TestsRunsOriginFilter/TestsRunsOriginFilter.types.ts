import type { RunOriginFilter } from '../model/runOrigin.types';

export interface TestsRunsOriginFilterProps {
  value: RunOriginFilter;
  onChange: (value: RunOriginFilter) => void;
}
