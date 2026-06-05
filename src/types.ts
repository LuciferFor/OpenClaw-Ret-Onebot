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

