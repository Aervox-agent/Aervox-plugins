import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PluginHostServices } from "@aervox/host-plugin-api";
import registration, { createToolContributions, TOOL_SPEC } from "../src/server/index.js";

const input = { name: "diary_list_styles", arguments: {}, turnId: "", attemptId: "", invocationId: "" };
describe("diary style metadata declaration", () => {
  it("matches the exact manifest name, read-only safety and input contract", () => {
    const manifest = JSON.parse(readFileSync(new URL("../plugin.manifest.json", import.meta.url), "utf8"));
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(registration.runtimeToolVersion).toBe(manifest.metadata.version);
    expect(pkg.version).toBe(manifest.metadata.version);
    const declared = manifest.spec.tools.find((tool: { name: string }) => tool.name === TOOL_SPEC.name);
    expect(TOOL_SPEC).toMatchObject({ name: declared.name, description: declared.description, parameters: declared.inputSchema, readOnly: true });
    expect(declared.requiredPermissions).toEqual(["diary.read"]);
  });
  it("reads current style metadata without model configuration or diary generation", async () => {
    const read = vi.fn(async () => [{ id: "custom", name: "Custom", description: "Registered style", targetScene: "general", systemPrompt: "SECRET_PROMPT" }]);
    const contribution = createToolContributions({ catalogs: { listDiaryStyles: read } } as unknown as PluginHostServices)[0]!;
    expect(await contribution.provider.execute(input)).toEqual({ ok: true, output: { items: [{ id: "custom", name: "Custom", description: "Registered style", targetScene: "general" }] } });
    expect(read).toHaveBeenCalledOnce();
    expect(contribution.provider.tools).toHaveLength(1);
  });
  it("does not advertise a tool on legacy hosts and does not turn list requests into generation", async () => {
    expect(createToolContributions({} as PluginHostServices)).toEqual([]);
    const read = vi.fn(async () => []);
    const contribution = createToolContributions({ catalogs: { listDiaryStyles: read } } as unknown as PluginHostServices)[0]!;
    expect(await contribution.provider.execute({ ...input, name: "diary_generate_styled" })).toMatchObject({ ok: false });
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects invalid or oversized style metadata", async () => {
    const contribution = createToolContributions({ catalogs: { listDiaryStyles: async () => [{ id: "huge", name: "Huge", description: "x".repeat(4097), targetScene: "general" }] } } as unknown as PluginHostServices)[0]!;
    expect(await contribution.provider.execute(input)).toEqual({ ok: false, error: "INVALID_CATALOG_RESULT" });
  });
});
