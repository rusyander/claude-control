import type { FactProps } from '../StepDetailModal.types';
import { Typography } from '@shared/ui/typography';

export function Fact({ label, children }: FactProps) {
  return (
    <>
      <dt>
        <Typography variant="caption" color="subtle" as="span">
          {label}
        </Typography>
      </dt>
      <dd>{children}</dd>
    </>
  );
}
