/**
 * Antigravity Agent provider — drives Google's Antigravity ACP server
 * (`agy_acp_server`) as a subprocess. This lets users with a Google account —
 * free, Google AI Pro or Ultra — use the in-app chat on Gemini without an API
 * key: the server signs in with the Google account and bills the account's
 * Antigravity quota.
 *
 * Unlike the Copilot CLI, the server has no command-line switches for its
 * built-in tools, so the boundary is drawn differently:
 *   - `GEMINI_HOME` points it at a directory of Trilium's own, so its sign-in,
 *     sessions, MCP servers and skills are Trilium's rather than those of the
 *     user's own Antigravity setup;
 *   - its file tools are confined to the (empty) agent cwd and its own home;
 *   - every tool that writes, runs a command or reaches the network asks
 *     permission first, and {@link decideAntigravityPermission} approves only
 *     Trilium's note tools.
 */

import type { ModelInfo } from "@triliumnext/core/src/services/llm/types.js";
import { existsSync } from "fs";
import path from "path";

import dataDirs from "../../data_dir.js";
import { AcpAgentProvider, type AcpLaunchSpec, type AcpNewSessionParams, type AcpPermissionOutcome, type AcpPermissionRequest, type AcpSessionModelState, type AcpToolCallUpdate, denyPermission, describeError, NOTE_TOOLS_MCP_SERVER_NAME } from "./acp_agent.js";
import { type AcpClient, AcpError } from "./acp_client.js";
import { resolveAntigravityBinaryPath } from "./antigravity_binary.js";

/** The model id that leaves the session on the model the server picks. */
const DEFAULT_MODEL_ID = "default";

/**
 * The catalog available without asking the server. Gemini's line-up moves too
 * fast to name here, so it holds only the entry that defers to the server's
 * own default.
 */
const AVAILABLE_MODELS: ModelInfo[] = [
    { id: DEFAULT_MODEL_ID, name: "Default", pricing: { input: 0, output: 0 }, isDefault: true, isSubscription: true }
];

/**
 * The sign-in method for a personal Google account, which covers the free tier
 * and Google AI Pro/Ultra alike. The server also offers `oauth-business`,
 * `gemini-api-key` and `agent-platform`, which the API-key Gemini provider
 * already serves better.
 */
const SIGN_IN_METHOD = "oauth-personal";

/** How long the add-provider screen waits for the user to finish signing in in the browser. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** CA bundle locations on common Linux distributions, in the order Go's crypto/x509 tries them. */
const LINUX_CA_BUNDLES = [
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
    "/etc/pki/tls/cacert.pem",
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    "/etc/ssl/cert.pem"
];

/** The cheap model for the title turn, recorded from the last probe. */
let titleModel: string | undefined;

export class AntigravityAgentProvider extends AcpAgentProvider {
    name = "antigravity-agent";
    protected readonly logLabel = "Antigravity Agent provider";
    protected readonly fallbackModels = AVAILABLE_MODELS;
    protected readonly defaultModelId = DEFAULT_MODEL_ID;
    protected readonly agentDirName = path.join("antigravity-agent", "workspace");

    /** Every model the account is offered: the plan already limits the list, and none costs extra. */
    recommendedModelIds(models: ModelInfo[]): Set<string> {
        return new Set(models.map(m => m.id));
    }

    protected titleModelId(): string | undefined {
        return titleModel;
    }

    protected async launchSpec(): Promise<AcpLaunchSpec> {
        const binary = await resolveAntigravityBinaryPath();
        return {
            binary,
            // The ACP registry launches the Linux build with an empty `--uid=`.
            args: process.platform === "linux" ? ["--uid="] : [],
            env: buildAntigravityEnv(agentHome())
        };
    }

    protected buildModelList(remote: AcpSessionModelState): ModelInfo[] {
        const models = buildAntigravityModelList(remote);
        titleModel = pickTitleModel(models);
        return models;
    }

    protected decidePermission(request: AcpPermissionRequest): AcpPermissionOutcome {
        return decideAntigravityPermission(request, this.logLabel);
    }

    /**
     * The agent writes a description of every MCP tool to
     * `<home>/antigravity-acp/brain/<session>/mcp/<server>/<tool>.json` and reads
     * them with its own file tools before calling one. Those reads are how it
     * looks a tool up, not work on the user's behalf.
     */
    protected isInternalToolCall(update: AcpToolCallUpdate): boolean {
        return isToolDescriptionAccess(update, agentHome());
    }

    /**
     * Open a session, signing in first when the server has no saved sign-in and
     * the user is on the add-provider screen to complete it. The server opens
     * the Google sign-in page in a browser on the machine running Trilium and
     * answers `authenticate` once the user has finished there; it keeps the
     * sign-in under `GEMINI_HOME`, so later sessions need none.
     */
    protected async createSession(client: AcpClient, params: AcpNewSessionParams, interactive: boolean, timeoutMs: number) {
        try {
            return await super.createSession(client, params, interactive, timeoutMs);
        } catch (err) {
            if (!interactive || !isSignInRequired(err)) {
                throw err;
            }
        }
        await client.request("authenticate", { methodId: SIGN_IN_METHOD }, SIGN_IN_TIMEOUT_MS);
        return await super.createSession(client, params, interactive, timeoutMs);
    }

    protected describeFailure(error: unknown): string {
        const text = describeError(error);
        if (isSignInRequired(error)) {
            return "Google Antigravity is not signed in. Open this provider in the AI settings and go to the model selection, which opens the Google sign-in page in a browser on the machine running Trilium.";
        }
        if (/"authenticate" timed out/.test(text)) {
            return "The Google sign-in was not completed in time. Try again, and finish signing in in the browser window that opens on the machine running Trilium.";
        }
        if (/ENOENT|spawn/i.test(text)) {
            return `Failed to start Google's Antigravity ACP server: ${text}`;
        }
        return text;
    }
}

/**
 * Approve Trilium's own note tools and deny everything else.
 *
 * The server asks before every MCP tool call, including those of the note-tools
 * server Trilium hands it. It marks those requests in `toolCall._meta` — the
 * MCP server's name and `is_mcp_tool_call` — which the server sets itself, so
 * the model cannot forge them the way it controls a tool call's title and
 * arguments. Built-in tools (shell, file edits, URL fetch, web search) carry no
 * such marker and are denied.
 */
export function decideAntigravityPermission(request: AcpPermissionRequest, logLabel: string): AcpPermissionOutcome {
    const meta = request.toolCall?._meta;
    const mcp = meta?.mcp as { server?: unknown } | undefined;
    const isNoteTool = meta?.is_mcp_tool_call === true && mcp?.server === NOTE_TOOLS_MCP_SERVER_NAME;
    const allowOnce = request.options?.find(o => o.kind === "allow_once");
    if (isNoteTool && allowOnce) {
        return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
    }
    return denyPermission(request, logLabel);
}

/**
 * The server's catalog, led by the entry that defers to its own default. The
 * server's order is kept: it is the picker Antigravity itself shows, newest
 * first.
 */
export function buildAntigravityModelList(remote: AcpSessionModelState): ModelInfo[] {
    const models = (remote.availableModels ?? [])
        .filter(m => m.modelId && m.modelId !== DEFAULT_MODEL_ID)
        .map<ModelInfo>(m => ({
            id: m.modelId,
            name: m.name ?? m.modelId,
            pricing: { input: 0, output: 0 },
            isSubscription: true
        }));
    return [...AVAILABLE_MODELS, ...models];
}

/**
 * Whether a built-in tool call only touches the agent's tool descriptions:
 * every path it names lies under `<home>/antigravity-acp/brain/<session>/mcp/`.
 * Anything else in the home, such as the sign-in token, does not qualify.
 */
export function isToolDescriptionAccess(update: AcpToolCallUpdate, home: string): boolean {
    if (update._meta && (update._meta as { is_mcp_tool_call?: unknown }).is_mcp_tool_call === true) {
        return false;
    }
    const paths = [
        ...(update.locations ?? []).map(location => location.path),
        ...Object.values(typeof update.rawInput === "object" && update.rawInput !== null ? update.rawInput : {})
    ].filter((value): value is string => typeof value === "string" && path.isAbsolute(value));
    return paths.length > 0 && paths.every(candidate => {
        const segments = path.relative(home, path.resolve(candidate)).split(path.sep);
        return segments[0] === "antigravity-acp" && segments[1] === "brain" && segments[3] === "mcp";
    });
}

/**
 * The environment the server runs in. `GEMINI_HOME` gives it a home of
 * Trilium's own. On Linux, `SSL_CERT_FILE` points it at the system CA bundle
 * when nothing else does: the server's bundled Python looks for one at a fixed
 * path that some distributions (NixOS) lack, and every model request then
 * fails certificate verification.
 */
export function buildAntigravityEnv(
    geminiHome: string,
    platform = process.platform,
    env = process.env,
    fileExists: (file: string) => boolean = existsSync
): Record<string, string> {
    const result: Record<string, string> = { GEMINI_HOME: geminiHome };
    if (platform === "linux" && !env.SSL_CERT_FILE) {
        const bundle = LINUX_CA_BUNDLES.find(candidate => fileExists(candidate));
        if (bundle) {
            result.SSL_CERT_FILE = bundle;
        }
    }
    return result;
}

/** The newest low-effort Flash model, which the catalog lists first among its peers. */
function pickTitleModel(models: ModelInfo[]): string | undefined {
    return models.find(m => /flash-low$/.test(m.id))?.id;
}

/** The server's home, `GEMINI_HOME`: its sign-in, sessions and tool descriptions. */
function agentHome(): string {
    return path.resolve(dataDirs.TRILIUM_DATA_DIR, "antigravity-agent", "home");
}

function isSignInRequired(error: unknown): boolean {
    return error instanceof AcpError && error.code === -32000 && /authentication required/i.test(error.message);
}
