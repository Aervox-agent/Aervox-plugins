import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PluginHostServices } from "@aervox/host-plugin-api";
import registration, { createToolContributions, TOOL_SPEC } from "../src/server/index.js";

const input = { name: "anki_list_providers", arguments: {}, turnId: "", attemptId: "", invocationId: "" };
describe("Anki parser metadata declaration", () => {
  it("matches the exact manifest name, read-only safety and input contract", () => {
    const manifest = JSON.parse(readFileSync(new URL("../plugin.manifest.json", import.meta.url), "utf8"));
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(registration.runtimeToolVersion).toBe(manifest.metadata.version);
    expect(pkg.version).toBe(manifest.metadata.version);
    const declared = manifest.spec.tools.find((tool: { name: string }) => tool.name === TOOL_SPEC.name);
    expect(TOOL_SPEC).toMatchObject({ name: declared.name, description: declared.description, parameters: declared.inputSchema, readOnly: true });
    expect(declared.requiredPermissions).toEqual(["learning.read"]);
  });
  it("lists the host registry with no Anki endpoint, credentials or configuration reads", async () => {
    const read = vi.fn(async () => [{ id: "json", name: "JSON", supportedExtensions: [".json"], apiKey: "SECRET" }]);
    const services = { catalogs: { listQuestionBankProviders: read, listDiaryStyles: vi.fn() } } as unknown as PluginHostServices;
    const contribution = createToolContributions(services)[0]!;
    expect(await contribution.provider.execute(input)).toEqual({ ok: true, output: { providers: [{ id: "json", name: "JSON", supportedExtensions: [".json"] }] } });
    expect(read).toHaveBeenCalledOnce();
    expect(contribution.provider.tools).toHaveLength(1);
  });
  it("does not advertise a tool in a host without catalog capabilities and refuses foreign tool names", async () => {
    expect(createToolContributions({} as PluginHostServices)).toEqual([]);
    const read = vi.fn(async () => []);
    const contribution = createToolContributions({ catalogs: { listQuestionBankProviders: read } } as unknown as PluginHostServices)[0]!;
    expect(await contribution.provider.execute({ ...input, name: "anki_import_deck" })).toMatchObject({ ok: false });
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects oversized metadata instead of returning an unbounded catalog", async () => {
    const contribution = createToolContributions({ catalogs: { listQuestionBankProviders: async () =>
      Array.from({ length: 65 }, () => ({ id: "parser", name: "Parser", supportedExtensions: [] })) } } as unknown as PluginHostServices)[0]!;
    expect(await contribution.provider.execute(input)).toEqual({ ok: false, error: "INVALID_CATALOG_RESULT" });
  });
});
