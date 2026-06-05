import { OneBotHookChannelPlugin } from "./channel.js";
import { registerService } from "./service.js";
import type { OpenClawPluginApi } from "./types.js";

export function register(api: OpenClawPluginApi): void {
  (globalThis as any).__onebotHookApi = api;

  api.logger?.info?.("[openclaw-onebot-hook] registering channel and reliable background service");
  api.registerChannel?.({ plugin: OneBotHookChannelPlugin });
  registerService(api);
}

export default function openclawOneBotHook(api: OpenClawPluginApi): void {
  register(api);
}

