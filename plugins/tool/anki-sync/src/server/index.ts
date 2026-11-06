import { z } from "zod";
import type { ToolSpec } from "@aervox/core";
import type { PluginHostServices, PluginToolContribution, ServerPluginRegistration } from "@aervox/host-plugin-api";

export const TOOL_SPEC: ToolSpec = {
  name: "anki_list_providers", description: "查询当前系统支持解析的外部题库格式与扩展名",
  readOnly: true, parameters: { type: "object" },
};
export const RESULT_PROJECTION = z.object({ providers: z.array(z.object({
  id: z.string().max(128), name: z.string().max(200), description: z.string().max(4096).optional(),
  supportedExtensions: z.array(z.string().max(32)).max(32),
})).max(64) });

export function createToolContributions(services: PluginHostServices): PluginToolContribution[] {
  if (!services.catalogs) return [];
  const catalogs = services.catalogs;
  return [{
    id: "question-bank-catalog", resultProjection: RESULT_PROJECTION,
    provider: {
      tools: [TOOL_SPEC],
      async execute(input) {
        if (input.name !== TOOL_SPEC.name) return { ok: false, error: "UNREGISTERED_CATALOG_TOOL" };
        const result = RESULT_PROJECTION.safeParse({ providers: await catalogs.listQuestionBankProviders() });
        return result.success ? { ok: true, output: result.data } : { ok: false, error: "INVALID_CATALOG_RESULT" };
      },
    },
  }];
}
const registration: ServerPluginRegistration = {
  pluginId: "ap-tool-anki-sync", runtimeToolVersion: "1.1.0", runtimeToolContributions: createToolContributions,
};
export default registration;
