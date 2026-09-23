import type { LlmStreamChunk } from "@triliumnext/commons";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const infoLogMock = vi.hoisted(() => vi.fn());
vi.mock("@triliumnext/core", () => ({
    getLog: () => ({ info: infoLogMock, error: vi.fn() }),
    // buildSystemPrompt reads the workspace task states; none in this unit test.
    task_states: { getTaskStates: () => [] }
}));

const DATA_DIR = path.join(os.tmpdir(), "trilium-antigravity-agent-spec");
vi.mock("../../data_dir.js", async () => {
    const os = await import("os");
    const path = await import("path");
    return { default: { TRILIUM_DATA_DIR: path.join(os.tmpdir(), "trilium-antigravity-agent-spec") } };
});

vi.mock("./antigravity_binary.js", () => ({ resolveAntigravityBinaryPath: async () => "/opt/agy/agy_acp_server.par" }));
vi.mock("./acp_mcp_endpoint.js", () => ({ getAcpMcpEndpointUrl: async () => "http://127.0.0.1:12345/mcp-secret" }));
vi.mock("@triliumnext/core/src/services/llm/note_hint.js", () => ({ buildNoteHint: () => null }));
vi.mock("@triliumnext/core/src/services/llm/attachment_content.js", () => ({ resolveAttachmentPart: vi.fn() }));

class FakeAcpError extends Error {
    constructor(public readonly code: number, message: string) {
        super(message);
    }
}

const SIGN_IN_REQUIRED = new FakeAcpError(-32000, "Authentication required");

/** Answers like `agy_acp_server`: `session/new` fails until `authenticate` has run, when `signedIn` is false. */
class FakeAcpClient {
    static current: FakeAcpClient | undefined;
    static lastStart: { binary: string; opts: { args?: string[]; env?: Record<string, string>; cwd: string } } | undefined;
    static signedIn = true;
    static availableModels: unknown[] = [];

    requests: { method: string; params: unknown }[] = [];
    onAgentRequest?: (method: string, params: unknown) => unknown;

    static start(binary: string, opts: { args?: string[]; env?: Record<string, string>; cwd: string; onAgentRequest?: (m: string, p: unknown) => unknown }) {
        FakeAcpClient.lastStart = { binary, opts };
        FakeAcpClient.current = new FakeAcpClient();
        FakeAcpClient.current.onAgentRequest = opts.onAgentRequest;
        return FakeAcpClient.current;
    }

    async request<T>(method: string, params: unknown): Promise<T> {
        this.requests.push({ method, params });
        if (method === "authenticate") {
            FakeAcpClient.signedIn = true;
        }
        if (method === "session/new") {
            if (!FakeAcpClient.signedIn) throw SIGN_IN_REQUIRED;
            return { sessionId: "sess-1", models: { currentModelId: "gemini-3.7-flash-high", availableModels: FakeAcpClient.availableModels } } as T;
        }
        if (method === "session/prompt") return { stopReason: "end_turn" } as T;
        return {} as T;
    }

    notify(): void {}
    dispose(): void {}

    methods(): string[] {
        return this.requests.map(r => r.method);
    }
}

vi.mock("./acp_client.js", () => ({ AcpClient: FakeAcpClient, AcpError: FakeAcpError }));

const { createUpdateCollector, resetAcpAgentStateForTests } = await import("./acp_agent.js");
const { AntigravityAgentProvider, buildAntigravityEnv, buildAntigravityModelList, decideAntigravityPermission } = await import("./antigravity_agent.js");
const { parseBuildLabel } = await vi.importActual<typeof import("./antigravity_binary.js")>("./antigravity_binary.js");

async function collect(iterable: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
    const chunks: LlmStreamChunk[] = [];
    for await (const chunk of iterable) {
        chunks.push(chunk);
    }
    return chunks;
}

const REMOTE_MODELS = [
    { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    { modelId: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
    { modelId: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" }
];

const PERMISSION_OPTIONS = [
    { optionId: "allow_always", name: "Allow Always", kind: "allow_always" },
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" }
];

beforeEach(() => {
    resetAcpAgentStateForTests();
    infoLogMock.mockReset();
    FakeAcpClient.current = undefined;
    FakeAcpClient.lastStart = undefined;
    FakeAcpClient.signedIn = true;
    FakeAcpClient.availableModels = REMOTE_MODELS;
});

describe("decideAntigravityPermission", () => {
    // Shapes captured from agy_acp_server 1.1.1.
    it("approves once a call to Trilium's note-tools MCP server", () => {
        expect(decideAntigravityPermission({
            toolCall: {
                toolCallId: "fa53",
                kind: "other",
                title: "trilium_search_notes",
                rawInput: { arguments: { query: "x" } },
                _meta: { mcp: { tool: "search_notes", server: "trilium" }, is_mcp_tool_call: true }
            },
            options: PERMISSION_OPTIONS
        }, "test")).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    });

    it("denies built-in tools, other MCP servers, and calls that only name Trilium in model-controlled fields", () => {
        const denied = { outcome: { outcome: "selected", optionId: "deny" } };
        // A shell command, as the server asks for it.
        expect(decideAntigravityPermission({
            toolCall: { toolCallId: "385f", kind: "execute", title: "id", rawInput: { CommandLine: "id" } },
            options: PERMISSION_OPTIONS
        }, "test")).toEqual(denied);
        // A tool from an MCP server Trilium did not provide.
        expect(decideAntigravityPermission({
            toolCall: { kind: "other", title: "other_fetch", _meta: { mcp: { tool: "fetch", server: "other" }, is_mcp_tool_call: true } },
            options: PERMISSION_OPTIONS
        }, "test")).toEqual(denied);
        // A built-in tool whose title and arguments the model filled with Trilium's name.
        expect(decideAntigravityPermission({
            toolCall: { kind: "fetch", title: "trilium_search_notes", rawInput: { Url: "https://example.com/?server=trilium" } },
            options: PERMISSION_OPTIONS
        }, "test")).toEqual(denied);
        // A note-tool call with no one-shot allow on offer is not approved permanently.
        expect(decideAntigravityPermission({
            toolCall: { kind: "other", _meta: { mcp: { server: "trilium" }, is_mcp_tool_call: true } },
            options: [PERMISSION_OPTIONS[0], PERMISSION_OPTIONS[2]]
        }, "test")).toEqual(denied);
    });
});

describe("AntigravityAgentProvider", () => {
    it("launches the server with a home of Trilium's own and routes permission requests through the policy", async () => {
        await collect(new AntigravityAgentProvider().chatChunks([{ role: "user", content: "hi" }], { enableNoteTools: true }));

        const start = FakeAcpClient.lastStart;
        expect(start?.binary).toBe("/opt/agy/agy_acp_server.par");
        expect(start?.opts.args).toEqual(process.platform === "linux" ? ["--uid="] : []);
        expect(start?.opts.env?.GEMINI_HOME).toBe(path.join(DATA_DIR, "antigravity-agent", "home"));
        expect(start?.opts.cwd).toBe(path.join(DATA_DIR, "antigravity-agent", "workspace"));

        const sessionNew = FakeAcpClient.current?.requests.find(r => r.method === "session/new");
        expect(sessionNew?.params).toMatchObject({ mcpServers: [{ name: "trilium", type: "http" }] });
        expect(FakeAcpClient.current?.onAgentRequest?.("session/request_permission", {
            toolCall: { kind: "execute", title: "rm -rf /" },
            options: PERMISSION_OPTIONS
        })).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    });

    it("signs in during the model probe, but reports a missing sign-in in the chat instead", async () => {
        FakeAcpClient.signedIn = false;
        const chunks = await collect(new AntigravityAgentProvider().chatChunks([{ role: "user", content: "hi" }], {}));
        expect(chunks).toEqual([{ type: "error", error: expect.stringContaining("not signed in") }]);
        expect(FakeAcpClient.current?.methods()).not.toContain("authenticate");

        const models = await new AntigravityAgentProvider().listModels();
        expect(FakeAcpClient.current?.methods()).toEqual(["initialize", "session/new", "authenticate", "session/new"]);
        expect(FakeAcpClient.current?.requests[2].params).toEqual({ methodId: "oauth-personal" });
        expect(models.map(m => m.id)).toEqual(["default", "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.7-flash-low", "gemini-pro-agent"]);
    });

    it("leaves the default model to the server, selects any other, and titles on the newest Flash Low", async () => {
        const provider = new AntigravityAgentProvider();
        await collect(provider.chatChunks([{ role: "user", content: "hi" }], {}));
        expect(FakeAcpClient.current?.methods()).not.toContain("session/set_model");

        await collect(provider.chatChunks([{ role: "user", content: "hi" }], { model: "gemini-pro-agent" }));
        expect(FakeAcpClient.current?.requests.find(r => r.method === "session/set_model")?.params).toEqual({ sessionId: "sess-1", modelId: "gemini-pro-agent" });

        await provider.listModels();
        await provider.generateTitle("plan my week");
        expect(FakeAcpClient.current?.requests.find(r => r.method === "session/set_model")?.params).toEqual({ sessionId: "sess-1", modelId: "gemini-3.8-flash-low" });
        expect(provider.recommendedModelIds(await provider.listModels()).size).toBe(5);
    });
});

describe("tool call updates from agy_acp_server", () => {
    it("names an MCP tool call after the tool and unwraps its arguments", () => {
        const chunks: LlmStreamChunk[] = [];
        const collector = createUpdateCollector(chunk => chunks.push(chunk));
        const meta = { mcp: { tool: "search_icons", server: "trilium" }, is_mcp_tool_call: true };
        collector.onNotification("session/update", {
            sessionId: "sess-1",
            update: {
                sessionUpdate: "tool_call", toolCallId: "f6b5", title: "trilium_search_icons", kind: "other", status: "pending",
                content: [], rawInput: { arguments: { query: "font" } }, _meta: meta
            }
        });
        collector.onNotification("session/update", {
            sessionId: "sess-1",
            update: {
                sessionUpdate: "tool_call_update", toolCallId: "f6b5", status: "completed",
                content: [{ content: { text: "Search for icons", type: "text" }, type: "content" }], rawOutput: "Search for icons"
            }
        });

        expect(chunks).toEqual([
            { type: "tool_use", toolCallId: "f6b5", toolName: "search_icons", toolInput: { query: "font" } },
            { type: "tool_result", toolCallId: "f6b5", toolName: "search_icons", result: "Search for icons", isError: false }
        ]);
    });
});

describe("buildAntigravityModelList", () => {
    it("leads with the server's own default and keeps the server's order and names", () => {
        expect(buildAntigravityModelList({ availableModels: [{ modelId: "gemini-x" }, { modelId: "default" }, { modelId: "" }] })).toEqual([
            { id: "default", name: "Default", pricing: { input: 0, output: 0 }, isDefault: true, isSubscription: true },
            { id: "gemini-x", name: "gemini-x", pricing: { input: 0, output: 0 }, isSubscription: true }
        ]);
    });
});

describe("buildAntigravityEnv", () => {
    it("points SSL_CERT_FILE at the first CA bundle on Linux, only when unset", () => {
        const fedora = (file: string) => file === "/etc/pki/tls/certs/ca-bundle.crt";
        expect(buildAntigravityEnv("/home", "linux", {}, fedora)).toEqual({ GEMINI_HOME: "/home", SSL_CERT_FILE: "/etc/pki/tls/certs/ca-bundle.crt" });
        expect(buildAntigravityEnv("/home", "linux", { SSL_CERT_FILE: "/mine.pem" }, fedora)).toEqual({ GEMINI_HOME: "/home" });
        expect(buildAntigravityEnv("/home", "linux", {}, () => false)).toEqual({ GEMINI_HOME: "/home" });
        expect(buildAntigravityEnv("/home", "darwin", {}, () => true)).toEqual({ GEMINI_HOME: "/home" });
    });
});

describe("parseBuildLabel", () => {
    it("reads the build label, falling back to the first line", () => {
        expect(parseBuildLabel("Built on Wed Sep  2 2026\nBuild label: agy_acp_server_1.1.1\nBuild tool: Blaze")).toBe("agy_acp_server_1.1.1");
        expect(parseBuildLabel("agy 2.0\nmore")).toBe("agy 2.0");
    });
});
