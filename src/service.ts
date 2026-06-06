import { getOneBotHookConfig } from "./config.js";
import { MessageDeduper, OneBotClient } from "./onebot-client.js";
import { processInboundMessage } from "./inbound.js";
import type { OneBotMessageEvent, OpenClawPluginApi } from "./types.js";

const GLOBAL_SERVICE_KEY = "__openclawOneBotReliableHookService";
const ENABLE_INPROCESS_SERVICE_ENV = "ONEBOT_HOOK_INPROCESS_SERVICE";

interface OpenClawServiceContext {
  config?: unknown;
  logger?: OpenClawPluginApi["logger"];
}

export function registerService(api: OpenClawPluginApi): void {
  let client: OneBotClient | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let starting: Promise<void> | null = null;
  let stopped = true;
  const deduper = new MessageDeduper();

  const clearRetryTimer = () => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const service = {
    id: "onebot-reliable-hook",
    start: async (ctx?: OpenClawServiceContext) => {
      if (starting) return starting;
      if (!stopped) {
        (ctx?.logger ?? api.logger)?.debug?.("[onebot-hook] start skipped; service is already running");
        return;
      }

      starting = (async () => {
        if (!isInProcessServiceEnabled()) {
          stopped = false;
          (ctx?.logger ?? api.logger)?.info?.(
            `[onebot-hook] in-process service disabled; set ${ENABLE_INPROCESS_SERVICE_ENV}=1 to enable it. Sidecar should handle reliable delivery.`,
          );
          return;
        }

        const runtimeApi = { ...api, config: ctx?.config ?? api.config, logger: ctx?.logger ?? api.logger };
        const logger = runtimeApi.logger;
        const config = getOneBotHookConfig(runtimeApi);
        if (!config) {
          logger?.warn?.("[onebot-hook] channels.onebot is not configured");
          return;
        }
        if (!config.enabled) {
          logger?.info?.("[onebot-hook] disabled by channels.onebot.enabled=false");
          return;
        }

        stopped = false;
        clearRetryTimer();
        logger?.info?.(
          `[onebot-hook] service starting account=${config.accountId} ws=${config.ws.mode}:${config.ws.url ?? `${config.ws.listenHost}:${config.ws.listenPort}${config.ws.path}`} http=${config.httpUrl ?? "none"}`,
        );

        const scheduleReconnect = (reason: string) => {
          if (stopped || retryTimer) return;
          logger?.warn?.(`[onebot-hook] scheduling reconnect after ${reason}`);
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void connect();
          }, 3000);
        };

        const connect = async () => {
          if (stopped) return;
          const nextClient = new OneBotClient(config, logger);
          nextClient.on("message", (message: OneBotMessageEvent) => {
            if (deduper.isDuplicate(message)) {
              logger?.debug?.("[onebot-hook] duplicate OneBot message ignored");
              return;
            }
            processInboundMessage(api, nextClient, config, message).catch((error) => {
              logger?.error?.(`[onebot-hook] process inbound failed: ${error instanceof Error ? error.message : String(error)}`);
            });
          });
          nextClient.on("close", () => {
            if (client === nextClient) client = null;
            scheduleReconnect("WebSocket close");
          });
          try {
            await nextClient.start();
            client = nextClient;
          } catch (error) {
            logger?.warn?.(`[onebot-hook] connect failed: ${error instanceof Error ? error.message : String(error)}`);
            await nextClient.stop().catch(() => undefined);
            scheduleReconnect("connect failure");
          }
        };

        await connect();
      })().finally(() => {
        starting = null;
      });
      return starting;
    },
    stop: async () => {
      stopped = true;
      starting = null;
      clearRetryTimer();
      await client?.stop();
      client = null;
      api.logger?.info?.("[onebot-hook] service stopped");
    },
  };

  api.registerService?.(service);

  const globalState = globalThis as typeof globalThis & {
    [GLOBAL_SERVICE_KEY]?: typeof service;
  };
  if (api.registerService) {
    if (globalState[GLOBAL_SERVICE_KEY] && globalState[GLOBAL_SERVICE_KEY] !== service) {
      void globalState[GLOBAL_SERVICE_KEY]?.stop?.();
    }
    globalState[GLOBAL_SERVICE_KEY] = service;
    setTimeout(() => {
      void service.start({ config: api.config, logger: api.logger }).catch((error) => {
        api.logger?.error?.(`[onebot-hook] autostart failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 0);
  }
}

function isInProcessServiceEnabled(): boolean {
  const value = process.env[ENABLE_INPROCESS_SERVICE_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
