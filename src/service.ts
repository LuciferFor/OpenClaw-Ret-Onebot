import { getOneBotHookConfig } from "./config.js";
import { MessageDeduper, OneBotClient } from "./onebot-client.js";
import { processInboundMessage } from "./inbound.js";
import type { OneBotMessageEvent, OpenClawPluginApi } from "./types.js";

export function registerService(api: OpenClawPluginApi): void {
  let client: OneBotClient | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  const deduper = new MessageDeduper();

  const clearRetryTimer = () => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  api.registerService?.({
    id: "onebot-reliable-hook",
    start: async () => {
      const config = getOneBotHookConfig(api);
      if (!config) {
        api.logger?.warn?.("[onebot-hook] channels.onebot is not configured");
        return;
      }
      if (!config.enabled) {
        api.logger?.info?.("[onebot-hook] disabled by channels.onebot.enabled=false");
        return;
      }

      stopped = false;
      clearRetryTimer();

      const scheduleReconnect = (reason: string) => {
        if (stopped || retryTimer) return;
        api.logger?.warn?.(`[onebot-hook] scheduling reconnect after ${reason}`);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void connect();
        }, 3000);
      };

      const connect = async () => {
        if (stopped) return;
        const nextClient = new OneBotClient(config, api.logger);
        nextClient.on("message", (message: OneBotMessageEvent) => {
          if (deduper.isDuplicate(message)) {
            api.logger?.debug?.("[onebot-hook] duplicate OneBot message ignored");
            return;
          }
          processInboundMessage(api, nextClient, config, message).catch((error) => {
            api.logger?.error?.(`[onebot-hook] process inbound failed: ${error instanceof Error ? error.message : String(error)}`);
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
          api.logger?.warn?.(`[onebot-hook] connect failed: ${error instanceof Error ? error.message : String(error)}`);
          await nextClient.stop().catch(() => undefined);
          scheduleReconnect("connect failure");
        }
      };

      await connect();
    },
    stop: async () => {
      stopped = true;
      clearRetryTimer();
      await client?.stop();
      client = null;
      api.logger?.info?.("[onebot-hook] service stopped");
    },
  });
}
