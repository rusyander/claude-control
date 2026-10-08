import type { AgentImageType } from '@agentdeck/contracts/agent-images';

/** Имя под новый тип: `shot.png`, ушедший JPEG-ом, — `shot.jpg`. */
export function renamedFor(name: string, mediaType: AgentImageType): string {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[
    mediaType
  ];
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const current = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (current === ext || (ext === 'jpg' && current === 'jpeg')) return name;
  return `${stem}.${ext}`;
}
