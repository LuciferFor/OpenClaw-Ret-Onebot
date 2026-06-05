import { getOneBotHookConfig } from "./config.js";
import { MessageDeduper, OneBotClient } from "./onebot-client.js";
import { processInboundMessage } from "./inbound.js";
import type { OneBotMessageEvent, OpenClawPluginApi } from "./types.js";

export function registerService(api: OpenClawPluginApi): void {
  let client: OneBotClient | null = null;
  const deduper = new MessageDeduper();

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

      client = new OneBotClient(config, api.logger);
      client.on("message", (message: OneBotMessageEvent) => {
        if (deduper.isDuplicate(message)) {
          api.logger?.debug?.("[onebot-hook] duplicate OneBot message ignored");
          return;
        }
        processInboundMessage(api, client!, config, message).catch((error) => {
          api.logger?.error?.(`[onebot-hook] process inbound failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      });
      await client.start();
    },
    stop: async () => {
      await client?.stop();
      client = null;
      api.logger?.info?.("[onebot-hook] service stopped");
    },
  });
}

