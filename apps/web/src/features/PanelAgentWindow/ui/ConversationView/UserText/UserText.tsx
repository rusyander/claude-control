import { splitAgentImages } from '@agentdeck/contracts/agent-images';
import { Typography } from '@shared/ui/typography';
import { SentImageNames } from '@shared/ui/image-attach';

/**
 * Реплика человека: текст и имена картинок под ним. Строку имён реплика несёт
 * по-английски для модели (`Attached images:`) — человеку она видна чипами.
 */
export function UserText({ text }: { text: string }) {
  const split = splitAgentImages(text);
  return (
    <>
      <Typography variant="body-sm" color="inverse">
        {split.text}
      </Typography>
      <SentImageNames names={split.images} inverse />
    </>
  );
}
