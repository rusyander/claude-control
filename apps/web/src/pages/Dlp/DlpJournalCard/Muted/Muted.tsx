import { Typography } from '@shared/ui/typography';

export function Muted({ text }: { text: string }) {
  return (
    <Typography variant="body-sm" color="subtle">
      {text}
    </Typography>
  );
}
