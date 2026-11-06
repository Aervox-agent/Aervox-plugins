import { z } from "zod";
import type { ToolSpec } from "@aervox/core";
import type { PluginHostServices, PluginToolContribution, ServerPluginRegistration } from "@aervox/host-plugin-api";

export const TOOL_SPEC: ToolSpec = {
  name: "diary_list_styles", description: "查询当前系统支持的所有日记提炼风格清单及其应用场景",
  readOnly: true, parameters: { type: "object" },
};
export const RESULT_PROJECTION = z.object({ items: z.array(z.object({
  id: z.string().max(128), name: z.string().max(200), description: z.string().max(4096), targetScene: z.string().max(128),
})).max(64) });

export function createToolContributions(services: PluginHostServices): PluginToolContribution[] {
  if (!services.catalogs) return [];
  const catalogs = services.catalogs;
  return [{
    id: "diary-style-catalog", resultProjection: RESULT_PROJECTION,
    provider: {
      tools: [TOOL_SPEC],
      async execute(input) {
        if (input.name !== TOOL_SPEC.name) return { ok: false, error: "UNREGISTERED_CATALOG_TOOL" };
        const result = RESULT_PROJECTION.safeParse({ items: await catalogs.listDiaryStyles() });
        return result.success ? { ok: true, output: result.data } : { ok: false, error: "INVALID_CATALOG_RESULT" };
      },
    },
  }];
}
const registration: ServerPluginRegistration = {
  pluginId: "ap-workflow-diary-distillers", runtimeToolVersion: "1.1.0", runtimeToolContributions: createToolContributions,
};
export default registration;
