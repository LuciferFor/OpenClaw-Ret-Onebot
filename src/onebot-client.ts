import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type {
  LoggerLike,
  OneBotApiResponse,
  OneBotHookConfig,
  OneBotImageData,
  OneBotMessageEvent,
  OneBotOutgoingMessage,
  OneBotSendData,
} from "./types.js";

interface PendingCall {
  resolve: (value: OneBotApiResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OneBotClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private server: WebSocketServer | null = null;
  private pending = new Map<string, PendingCall>();
  private stopped = false;

  constructor(
    private readonly config: OneBotHookConfig,
    private readonly logger: LoggerLike = {}
  ) {
    super();
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.config.ws.mode === "reverse") {
      await this.startReverse();
      return;
    }
    await this.startForward();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const [echo, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`OneBot call ${echo} cancelled during shutdown`));
    }
    this.pending.clear();

    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    } else if (ws) {
      ws.terminate();
    }

    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async sendPrivateMsg(userId: number, message: OneBotOutgoingMessage): Promise<OneBotApiResponse<OneBotSendData>> {
    return this.callApi<OneBotSendData>("send_private_msg", {
      user_id: userId,
      message,
      auto_escape: false,
    });
  }

  async sendGroupMsg(groupId: number, message: OneBotOutgoingMessage): Promise<OneBotApiResponse<OneBotSendData>> {
    return this.callApi<OneBotSendData>("send_group_msg", {
      group_id: groupId,
      message,
      auto_escape: false,
    });
  }

  async getImage(file: string): Promise<OneBotApiResponse<OneBotImageData>> {
    return this.callApi<OneBotImageData>("get_image", { file });
  }

  async callApi<T = unknown>(action: string, params: Record<string, unknown>): Promise<OneBotApiResponse<T>> {
    if (this.config.httpUrl) {
      return this.callHttp<T>(action, params);
    }
    return this.callWs<T>(action, params);
  }

  private async startForward(): Promise<void> {
    const url = this.config.ws.url;
    if (!url) {
      throw new Error("channels.onebot.ws.url is required when ws.mode is forward");
    }
    await this.openSocket(url);
  }

  private async startReverse(): Promise<void> {
    const host = this.config.ws.listenHost ?? "127.0.0.1";
    const port = this.config.ws.listenPort ?? 3002;
    const path = this.config.ws.path ?? "/onebot/v11/ws";
    this.server = new WebSocketServer({ host, port, path });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server?.once("error", onError);
      this.server?.once("listening", onListening);
    });

    this.server.on("connection", (socket) => {
      this.logger.info?.(`[onebot-hook] reverse WebSocket connected`);
      this.attachSocket(socket);
    });
    this.logger.info?.(`[onebot-hook] reverse WebSocket listening on ${host}:${port}${path}`);
  }

  private async openSocket(url: string): Promise<void> {
    const headers = this.authHeaders();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { headers });
      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
      };
      const onOpen = () => {
        cleanup();
        this.attachSocket(socket);
        this.logger.info?.(`[onebot-hook] forward WebSocket connected: ${url}`);
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });
  }

  private attachSocket(socket: WebSocket): void {
    if (this.ws && this.ws !== socket) this.ws.close();
    this.ws = socket;
    socket.on("message", (data) => this.handleSocketMessage(data));
    socket.on("close", () => {
      if (this.ws === socket) this.ws = null;
      if (!this.stopped) {
        this.logger.warn?.("[onebot-hook] WebSocket closed");
        this.emit("close");
      }
    });
    socket.on("error", (error) => this.logger.error?.(`[onebot-hook] WebSocket error: ${error.message}`));
  }

  private handleSocketMessage(data: RawData): void {
    let payload: any;
    try {
      payload = JSON.parse(data.toString());
    } catch (error) {
      this.logger.warn?.(`[onebot-hook] ignored invalid JSON from OneBot: ${String(error)}`);
      return;
    }

    if (payload?.echo && this.pending.has(String(payload.echo))) {
      const pending = this.pending.get(String(payload.echo))!;
      this.pending.delete(String(payload.echo));
      clearTimeout(pending.timer);
      pending.resolve(payload);
      return;
    }

    if (payload?.meta_event_type === "heartbeat") return;
    if (payload?.post_type === "message" && (payload.message_type === "private" || payload.message_type === "group")) {
      this.emit("message", payload as OneBotMessageEvent);
    }
  }

  private async callHttp<T>(action: string, params: Record<string, unknown>): Promise<OneBotApiResponse<T>> {
    const base = this.config.httpUrl!.replace(/\/+$/, "");
    const response = await fetch(`${base}/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.authHeaders(),
      },
      body: JSON.stringify(params),
    });
    const body = (await response.json().catch(() => ({}))) as OneBotApiResponse<T>;
    if (!response.ok) {
      throw new Error(`OneBot HTTP ${action} failed with ${response.status}: ${JSON.stringify(body)}`);
    }
    return body;
  }

  private async callWs<T>(action: string, params: Record<string, unknown>): Promise<OneBotApiResponse<T>> {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("OneBot WebSocket is not connected and httpUrl is not configured");
    }
    const echo = `openclaw-onebot-hook:${randomUUID()}`;
    return new Promise<OneBotApiResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot WebSocket action timed out: ${action}`));
      }, 15_000);
      this.pending.set(echo, { resolve: resolve as (value: OneBotApiResponse) => void, reject, timer });
      socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error);
      });
    });
  }

  private authHeaders(): Record<string, string> {
    return this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : {};
  }
}

export class MessageDeduper {
  private seen = new Map<string, number>();

  constructor(private readonly ttlMs = 60_000) {}

  isDuplicate(message: OneBotMessageEvent, now = Date.now()): boolean {
    this.cleanup(now);
    const key = this.keyFor(message);
    const last = this.seen.get(key);
    if (last != null && now - last <= this.ttlMs) return true;
    this.seen.set(key, now);
    return false;
  }

  private cleanup(now: number): void {
    for (const [key, ts] of this.seen) {
      if (now - ts > this.ttlMs) this.seen.delete(key);
    }
  }

  private keyFor(message: OneBotMessageEvent): string {
    if (message.message_id != null) {
      return `${message.self_id ?? ""}:${message.message_type ?? ""}:${message.group_id ?? ""}:${message.user_id ?? ""}:${message.message_id}`;
    }
    const raw = `${message.time ?? ""}:${message.message_type ?? ""}:${message.group_id ?? ""}:${message.user_id ?? ""}:${message.raw_message ?? JSON.stringify(message.message ?? "")}`;
    return createHash("sha256").update(raw).digest("hex");
  }
}

export function isOkResponse(response: OneBotApiResponse): boolean {
  return response.status === undefined || response.status === "ok" || response.retcode === 0;
}
