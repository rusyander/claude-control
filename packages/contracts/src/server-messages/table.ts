/**
 * Все коды текстов сервера одной таблицей. Разложены по областям, чтобы
 * таблица не росла одним файлом; ключ повторяться между областями не может —
 * это сверяет тест словарей (число кодов = сумма областей).
 */
import { chatMessageParams } from './chat.ts';
import { checksMessageParams } from './checks.ts';
import { commonMessageParams } from './common.ts';
import { composedMessageParams } from './composed.ts';
import { configMessageParams } from './config.ts';
import { contourMessageParams } from './contour.ts';
import { dlpMessageParams } from './dlp.ts';
import { filesMessageParams } from './files.ts';
import { gatewayMessageParams } from './gateway.ts';
import { gitMessageParams } from './git.ts';
import { integrationsMessageParams } from './integrations.ts';
import { mediaMessageParams } from './media.ts';
import { platformMessageParams } from './platform.ts';
import { sandboxMessageParams } from './sandbox.ts';
import { systemMessageParams } from './system.ts';
import { testsMessageParams } from './tests.ts';
import { transferMessageParams } from './transfer.ts';

export const serverMessageAreas = {
  chat: chatMessageParams,
  checks: checksMessageParams,
  common: commonMessageParams,
  composed: composedMessageParams,
  config: configMessageParams,
  contour: contourMessageParams,
  dlp: dlpMessageParams,
  files: filesMessageParams,
  gateway: gatewayMessageParams,
  git: gitMessageParams,
  integrations: integrationsMessageParams,
  media: mediaMessageParams,
  platform: platformMessageParams,
  sandbox: sandboxMessageParams,
  system: systemMessageParams,
  tests: testsMessageParams,
  transfer: transferMessageParams,
} as const;

export const serverMessageParams = {
  ...chatMessageParams,
  ...checksMessageParams,
  ...commonMessageParams,
  ...composedMessageParams,
  ...configMessageParams,
  ...contourMessageParams,
  ...dlpMessageParams,
  ...filesMessageParams,
  ...gatewayMessageParams,
  ...gitMessageParams,
  ...integrationsMessageParams,
  ...mediaMessageParams,
  ...platformMessageParams,
  ...sandboxMessageParams,
  ...systemMessageParams,
  ...testsMessageParams,
  ...transferMessageParams,
} as const satisfies Record<string, readonly string[]>;

export type ChatMessageCode = keyof typeof chatMessageParams;
export type ChecksMessageCode = keyof typeof checksMessageParams;
export type CommonMessageCode = keyof typeof commonMessageParams;
export type ComposedMessageCode = keyof typeof composedMessageParams;
export type ConfigMessageCode = keyof typeof configMessageParams;
export type ContourMessageCode = keyof typeof contourMessageParams;
export type DlpMessageCode = keyof typeof dlpMessageParams;
export type FilesMessageCode = keyof typeof filesMessageParams;
export type GatewayMessageCode = keyof typeof gatewayMessageParams;
export type GitMessageCode = keyof typeof gitMessageParams;
export type IntegrationsMessageCode = keyof typeof integrationsMessageParams;
export type MediaMessageCode = keyof typeof mediaMessageParams;
export type PlatformMessageCode = keyof typeof platformMessageParams;
export type SandboxMessageCode = keyof typeof sandboxMessageParams;
export type SystemMessageCode = keyof typeof systemMessageParams;
export type TestsMessageCode = keyof typeof testsMessageParams;
export type TransferMessageCode = keyof typeof transferMessageParams;
