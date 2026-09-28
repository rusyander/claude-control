import type { RunOriginFilter } from './model/runOrigin';

export interface TestsRunsOriginFilterProps {
  value: RunOriginFilter;
  onChange: (value: RunOriginFilter) => void;
}
