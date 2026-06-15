export type OneBotWsMode = "forward" | "reverse";

export interface OneBotWsConfig {
  mode: OneBotWsMode;
  url?: string;
  listenHost?: string;
  listenPort?: number;
  path?: string;
}

export interface OneBotTriggerConfig {
  private: "all";
  group: "mention_or_keyword";
  keywords: string[];
  stripMention: boolean;
}

export interface OneBotReplyConfig {
  mode: "chunked";
  flushIntervalMs: number;
  flushChars: number;
  markdownToPlain: boolean;
  maxRetries: number;
}

export interface OneBotMediaConfig {
  enabled: boolean;
  downloadInboundImages: boolean;
  cacheDir: string;
  maxImageBytes: number;
  downloadTimeoutMs: number;
  retainHours: number;
  outboundMode: "segments";
  markdownImages: boolean;
  maxImagesPerReply: number;
}

export interface OneBotFilePathMapping {
  from: string;
  to: string;
}

export interface OneBotFileConfig {
  enabled: boolean;
  maxFileBytes: number;
  detectTextPaths: boolean;
  downloadInboundFiles: boolean;
  incomingDir: string;
  downloadTimeoutMs: number;
  allowedRoots: string[];
  pathMappings: OneBotFilePathMapping[];
  fallbackOnFailure: "text";
}

export interface OneBotHookConfig {
  enabled: boolean;
  accountId: string;
  ws: OneBotWsConfig;
  httpUrl?: string;
  accessToken?: string;
  trigger: OneBotTriggerConfig;
  allowFrom: string[];
  denyFrom: string[];
  reply: OneBotReplyConfig;
  media: OneBotMediaConfig;
  files: OneBotFileConfig;
}

export interface OneBotSenderInfo {
  user_id?: number;
  nickname?: string;
  card?: string;
}

export interface OneBotMessageSegment {
  type: string;
  data?: Record<string, unknown>;
}

export type OneBotOutgoingMessage = string | OneBotMessageSegment[];

export type InboundMediaKind = "image" | "record" | "video" | "file";

export interface InboundTextPart {
  kind: "text";
  text: string;
}

export interface InboundMentionPart {
  kind: "mention";
  qq: string;
  text: string;
  self: boolean;
}

export interface InboundReplyPart {
  kind: "reply";
  segmentType: string;
  data: Record<string, unknown>;
  messageId?: string;
  quotedParts?: InboundMessagePart[];
  quotedText?: string;
  quotedSenderId?: string;
  quotedSenderName?: string;
  resolveStatus?: "resolved" | "skipped" | "failed";
  resolveError?: string;
}

export interface InboundMediaPart {
  kind: InboundMediaKind;
  segmentType: string;
  data: Record<string, unknown>;
  file?: string;
  fileId?: string;
  url?: string;
  source?: string;
  summary?: string;
  filename?: string;
  mime?: string;
  size?: number;
  localPath?: string;
  localFileUri?: string;
  downloadStatus?: "saved" | "skipped" | "failed";
  downloadError?: string;
}

export interface InboundUnknownPart {
  kind: "unknown";
  segmentType: string;
  data: Record<string, unknown>;
  text: string;
}

export type InboundMessagePart = InboundTextPart | InboundMentionPart | InboundReplyPart | InboundMediaPart | InboundUnknownPart;

export interface OneBotMessageEvent {
  time?: number;
  self_id?: number;
  post_type: string;
  message_type?: "private" | "group";
  sub_type?: string;
  message_id?: number | string;
  user_id?: number;
  group_id?: number;
  message?: string | OneBotMessageSegment[];
  raw_message?: string;
  sender?: OneBotSenderInfo;
  [key: string]: unknown;
}

export interface CapturedReplyTarget {
  kind: "private" | "group";
  id: number;
}

export interface OneBotApiResponse<T = unknown> {
  status?: string;
  retcode?: number;
  data?: T;
  message?: string;
  wording?: string;
  echo?: string;
}

export interface OneBotSendData {
  message_id?: number | string;
}

export interface OneBotFileUploadData {
  message_id?: number | string;
  file_id?: number | string;
  file?: string;
}

export interface OneBotImageData {
  file?: string;
  url?: string;
  path?: string;
  filename?: string;
  [key: string]: unknown;
}

export interface OneBotMessageData {
  message_id?: number | string;
  real_id?: number | string;
  sender?: OneBotSenderInfo;
  user_id?: number | string;
  group_id?: number | string;
  message?: string | OneBotMessageSegment[];
  raw_message?: string;
  time?: number;
  [key: string]: unknown;
}

export interface OneBotFileData {
  file?: string;
  file_id?: string;
  url?: string;
  path?: string;
  name?: string;
  filename?: string;
  file_name?: string;
  size?: number | string;
  file_size?: number | string;
  mime?: string;
  mime_type?: string;
  [key: string]: unknown;
}

export interface LoggerLike {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface OpenClawPluginApi {
  config?: any;
  logger?: LoggerLike;
  runtime?: any;
  registrationMode?: string;
  registerChannel?: (registration: { plugin: unknown }) => void;
  registerService?: (service: {
    id: string;
    start: () => Promise<void> | void;
    stop: () => Promise<void> | void;
  }) => void;
  registerTool?: never;
}
