// @ts-check
/**
 * dsh-worktree — Codex-style permanent git worktrees for DeepSeek Harness.
 *
 * What this plugin gives a DSH profile:
 *
 * 1. Agent tools `worktree_create`, `worktree_list`, `worktree_remove` — the
 *    model can create a permanent detached worktree (like `codex worktree
 *    create --permanent`), list them, and remove them.
 * 2. A human `/worktree` command (`create | list | open | remove`) — the
 *    Codex CLI surface, in the DSH chat.
 * 3. Durable checkouts: every worktree this plugin creates is a real
 *    `git worktree add --detach` under `<repo>/.dsh-worktrees/<name>`.
 *    Git is the only record. A worktree is not a workspace, so it does not
 *    appear in the workspace menu. The session stays in the workspace it was
 *    opened in; the working directory moves to the worktree on the first prompt.
 * 4. Session context: when a session runs inside a linked git worktree, the
 *    agent is told so once per session.
 *
 * @module dsh-worktree
 */
import crypto from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { WorktreeManager, WorktreeError, WORKTREE_HELP, canonicalPath } from "./manager.js";

const name = "worktree";
const inject = ["tools", "commands", "subprocess"];

/**
 * Plugin configuration.
 * - `dirName`: directory (inside each git repo root) where worktrees this
 *   plugin creates are grouped. Default `.dsh-worktrees`. It is not a registry.
 */
const Config = z.object({
	dirName: z.string().default(".dsh-worktrees")
});

/** Resolve the working directory a tool/command call operates from. */
function sessionCwd(agent) {
	return agent?.session?.header?.cwd ?? process.cwd();
}

/** Short formatter for a commit SHA (like `git rev-parse --short`). */
function shortSha(sha) {
	return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/** Render a list result as plain text (shared by tool output and command). */
function renderList(result) {
	const { repoRoot, worktrees } = result;
	if (worktrees.length === 0) {
		return `No git worktrees in ${repoRoot}.\nCreate one with worktree_create or /worktree create <name> [<base-commit>].`;
	}
	const lines = [`Git worktrees of ${repoRoot}:`];
	for (const entry of worktrees) {
		const head = entry.branch ?? (entry.head ? `detached @ ${shortSha(entry.head)}` : "unknown");
		const role = entry.main ? "main" : "linked";
		lines.push(`  ${entry.name}  →  ${entry.path}  [${head}]  ${role}`);
	}
	return lines.join("\n");
}

/** Create a permanent worktree. It is not added to the workspace list. */
function createWorktree(manager, params) {
	return manager.create(params);
}

/** Best-effort removal of a worktree's workspace registration (dir is gone). */
async function unregisterWorkspace(ctx, manager, pathToRemove) {
	const registry = ctx.get("workspaceRegistry");
	if (registry === undefined) return;
	try {
		const workspace = await registry.resolveByPath(pathToRemove);
		if (workspace !== undefined) await registry.delete(workspace.id);
	} catch {
		// Stale registration is harmless; the worktree itself is already gone.
	}
}

/** Register the three model-facing worktree tools. */
function registerTools(ctx, manager) {
	ctx.tools.register(defineTool({
		name: "worktree_create",
		description: "Create a PERMANENT git worktree — a detached checkout under <repo>/.dsh-worktrees/<name>. It is not added to the workspace list. The current session stays in its workspace.",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Unique name for the worktree (letters, digits, '.', '_', '-'; no leading '-' or '.')."
			},
			baseCommit: {
				type: "string",
				description: "Commit-ish to check out (default: the repository's current HEAD)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: { type: "string", required: true },
					path: { type: "string", required: true },
					repoRoot: { type: "string", required: true },
					baseCommit: { type: "string", required: true },
					permanent: { type: "boolean", required: true },
					createdAt: { type: "string", required: true },
					note: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: [
					`Created permanent worktree ${JSON.stringify(value.name)} at ${value.path}`,
					`  repo: ${value.repoRoot}`,
					`  base commit: ${value.baseCommit} (permanent)`,
					"  It is not a workspace. /worktree open <name> switches this session's directory there."
				].join("\n")
			}]
		},
		execute(args, exec) {
			const cwd = sessionCwd(exec.agent);
			return createWorktree(manager, {
				name: args.name,
				baseCommit: args.baseCommit,
				cwd,
				createdBy: exec.agent ? String(exec.agent.session.id) : null,
				signal: exec.signal
			}).then((result) => ({
				name: result.worktree.name,
				path: result.worktree.path,
				repoRoot: result.repoRoot,
				baseCommit: result.worktree.baseCommit,
				permanent: result.worktree.permanent,
				createdAt: result.worktree.createdAt
			}));
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Create permanent worktree",
			kind: "other",
			rawInput: args
		})
	}));

	ctx.tools.register(defineTool({
		name: "worktree_list",
		description: "List every git worktree of the repository containing the current session (the same checkouts as `git worktree list`, including ones created by other agents), with path, HEAD, and branch or detached state.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					repoRoot: { type: "string", required: true },
					dir: { type: "string", required: true },
					worktrees: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								path: { type: "string", required: true },
								exists: { type: "boolean", required: true },
								main: { type: "boolean", required: true },
								detached: { type: "boolean", required: true },
								head: { type: "string" },
								branch: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => [{ type: "text", text: renderList(value) }]
		},
		execute(_args, exec) {
			return manager.list(sessionCwd(exec.agent), exec.signal).then((result) => ({
				repoRoot: result.repoRoot,
				dir: result.dir,
				worktrees: result.worktrees.map((entry) => ({
					name: entry.name,
					path: entry.path,
					exists: entry.exists,
					main: entry.main === true,
					detached: entry.detached === true || entry.branch == null,
					...(entry.head != null ? { head: entry.head } : {}),
					...(entry.branch != null ? { branch: entry.branch } : {})
				}))
			}));
		},
		presentCall: () => ({
			card: "generic",
			title: "List permanent worktrees",
			kind: "other",
			rawInput: {}
		})
	}));

	ctx.tools.register(defineTool({
		name: "worktree_remove",
		description: "Remove a linked git worktree by the name worktree_list shows (`git worktree remove`; with force, even uncommitted changes). Refuses the main checkout and the worktree the current session is working inside.",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Registered worktree name to remove."
			},
			force: {
				type: "boolean",
				description: "Pass --force to git so removal succeeds even with uncommitted changes (default false)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: { type: "string", required: true },
					path: { type: "string", required: true },
					repoRoot: { type: "string", required: true },
					removed: { type: "boolean", required: true },
					force: { type: "boolean", required: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Removed permanent worktree ${JSON.stringify(value.name)} at ${value.path}${value.force ? " (forced)" : ""}.`
			}]
		},
		execute(args, exec) {
			const cwd = sessionCwd(exec.agent);
			return manager.remove({
				name: args.name,
				cwd,
				currentDir: cwd,
				force: args.force === true,
				signal: exec.signal
			}).then(async (result) => {
				await unregisterWorkspace(ctx, manager, result.path);
				return result;
			});
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Remove permanent worktree",
			kind: "other",
			rawInput: args
		})
	}));
}

/** Parse `/worktree ...` into a typed request; errors carry usage help. */
function parseCommand(rawInput) {
	const tokens = rawInput.trim().split(/\s+/u).filter(Boolean);
	if (tokens.length === 0) return { kind: "list" };
	const [verb, ...rest] = tokens;
	switch (verb) {
		case "help":
		case "--help":
		case "-h":
			if (rest.length !== 0) return { kind: "usage" };
			return { kind: "help" };
		case "list":
		case "ls":
			if (rest.length !== 0) return { kind: "usage" };
			return { kind: "list" };
		case "create":
		case "creat": {
			if (rest.length < 1 || rest.length > 2) return { kind: "usage" };
			return { kind: "create", name: rest[0], baseCommit: rest[1] };
		}
		case "open":
		case "remove":
		case "close":
		case "delete": {
			if (rest.length !== 1) return { kind: "usage" };
			return { kind: verb === "open" ? "open" : "remove", name: rest[0] };
		}
		default:
			return { kind: "unknown", verb };
	}
}

/**
 * Execute one parsed `/worktree` request against the manager.
 * @returns {Promise<{kind: "success"|"error", text: string}>}
 */
async function executeWorktreeCommand(ctx, manager, invocation) {
	const parsed = parseCommand(invocation.rawInput);
	const cwd = sessionCwd(invocation.agent);
	const usage = WORKTREE_HELP;
	try {
		switch (parsed.kind) {
			case "help":
				return { kind: "success", text: WORKTREE_HELP };
			case "usage":
				return { kind: "error", text: usage };
			case "unknown":
				return { kind: "error", text: `Unknown /worktree verb ${JSON.stringify(parsed.verb)}.\n${usage}` };
			case "list": {
				const result = await manager.list(cwd, invocation.signal);
				return { kind: "success", text: renderList(result) };
			}
			case "create": {
				const result = await createWorktree(manager, {
					name: parsed.name,
					baseCommit: parsed.baseCommit,
					cwd,
					createdBy: null,
					signal: invocation.signal
				});
				return {
					kind: "success",
					text: [
						`Created permanent worktree ${JSON.stringify(result.worktree.name)} at ${result.worktree.path}`,
						`  repo: ${result.repoRoot}`,
						`  base commit: ${result.worktree.baseCommit}`,
						"It was not added to the workspace list. /worktree open <name> switches this session's directory there."
					].join("\n")
				};
			}
			case "open": {
				const list = await manager.list(cwd, invocation.signal);
				const entry = list.worktrees.find((candidate) => candidate.name === parsed.name);
				if (entry === undefined) {
					return { kind: "error", text: `no git worktree named ${JSON.stringify(parsed.name)} in ${list.repoRoot}` };
				}
				if (entry.main) {
					return {
						kind: "success",
						text: [
							`Main checkout ${JSON.stringify(entry.name)} of ${list.repoRoot}`,
							`  path: ${entry.path}`,
							`  HEAD: ${entry.head ?? "unknown"}`,
							"This is the primary checkout. Start a session with this directory as its workspace to work in it."
						].join("\n")
					};
				}
				if (!entry.exists) {
					return { kind: "error", text: `worktree ${JSON.stringify(parsed.name)} is listed by git but its checkout is gone (${entry.path})` };
				}
				let switched = false;
				let switchError = "";
				try {
					const directory = ctx.get("workingDirectory");
					if (directory !== undefined && invocation.agent) {
						await directory.set(invocation.agent, entry.path, invocation.signal);
						switched = true;
					}
				} catch (error) {
					switchError = error instanceof Error ? error.message : "could not switch directory";
				}
				const head = entry.branch ?? (entry.head ? `detached @ ${shortSha(entry.head)}` : "unknown");
				return {
					kind: "success",
					text: [
						`Git worktree ${JSON.stringify(entry.name)} of ${list.repoRoot}`,
						`  path: ${entry.path}`,
						`  HEAD: ${entry.head ?? "unknown"}`,
						`  current: ${head}`,
						switched
							? "Working directory is now this worktree. The session stays in its workspace."
							: `Could not switch the working directory${switchError ? `: ${switchError}` : ""}.`
					].join("\n")
				};
			}
			case "remove": {
				const result = await manager.remove({
					name: parsed.name,
					cwd,
					currentDir: cwd,
					signal: invocation.signal
				});
				await unregisterWorkspace(ctx, manager, result.path);
				return { kind: "success", text: `Removed permanent worktree ${JSON.stringify(result.name)} at ${result.path}.` };
			}
			default:
				return { kind: "error", text: usage };
		}
	} catch (error) {
		if (error instanceof WorktreeError) return { kind: "error", text: error.message };
		throw error;
	}
}

/** Register the human-facing `/worktree` command (Codex CLI surface). */
function registerCommand(ctx, manager) {
	ctx.commands.register({
		name: "worktree",
		description: "create, list, open, or remove git worktrees",
		input: { hint: "help | create <name> [<base-commit>] | list | open <name> | remove <name>" },
		handler: (invocation) => executeWorktreeCommand(ctx, manager, invocation)
	});
}

/** Repos whose sessions should stay on the main checkout. */
const optedOutRepos = new Set();
/** The next new session should stay on the main checkout when its path is not known yet. */
let optOutNext = false;
const preparedSessions = new Set();

/**
 * @param {string} repoRoot
 * @param {boolean} enabled true means the first prompt creates a worktree.
 */
function setSessionWorktreeMode(repoRoot, enabled) {
	let key = repoRoot;
	try {
		if (repoRoot) key = canonicalPath(repoRoot);
	} catch {
		key = repoRoot;
	}
	if (enabled) {
		if (key) optedOutRepos.delete(key);
		optOutNext = false;
		return;
	}
	if (key) optedOutRepos.add(key);
	else optOutNext = true;
}

function freshWorktreeName() {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let suffix = "";
	for (let i = 0; i < 4; i += 1) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
	return `session-${stamp}-${suffix}`;
}

/**
 * Create the session worktree on the first model step, after the user has sent
 * a prompt. The working directory moves. Workspace membership does not.
 * @param {any} ctx
 * @param {WorktreeManager} manager
 * @param {any} agent
 * @param {AbortSignal | undefined} signal
 */
async function ensureFreshWorktree(ctx, manager, agent, signal) {
	const sessionId = agent?.session?.id;
	if (sessionId === undefined || sessionId === null) return;
	const key = String(sessionId);
	if (preparedSessions.has(key)) return;
	const cwd = sessionCwd(agent);
	let root;
	try {
		root = await manager.resolveRepoRoot(cwd, signal);
	} catch (error) {
		if (error instanceof WorktreeError && error.code === "NOT_A_GIT_REPO") {
			preparedSessions.add(key);
			return;
		}
		throw error;
	}
	if (await manager.findForCwd(cwd, signal)) {
		preparedSessions.add(key);
		return;
	}
	let repoKey = root;
	try {
		repoKey = canonicalPath(root);
	} catch {
		repoKey = root;
	}
	let cwdKey = cwd;
	try {
		cwdKey = canonicalPath(cwd);
	} catch {
		cwdKey = cwd;
	}
	if (optOutNext) {
		optOutNext = false;
		optedOutRepos.add(repoKey);
		optedOutRepos.add(cwdKey);
	}
	if (optedOutRepos.has(repoKey) || optedOutRepos.has(cwdKey)) {
		preparedSessions.add(key);
		return;
	}
	preparedSessions.add(key);
	const created = await manager.create({
		name: freshWorktreeName(),
		cwd: root,
		createdBy: key,
		signal
	});
	const directory = ctx.get("workingDirectory");
	if (directory !== undefined && typeof directory.set === "function") {
		await directory.set(agent, created.worktree.path, signal);
	}
}

function registerSessionWorktree(ctx, manager) {
	if (typeof ctx.on !== "function") return;
	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		try {
			await ensureFreshWorktree(ctx, manager, agent, signal);
		} catch (error) {
			const sessionId = agent?.session?.id;
			if (sessionId !== undefined && sessionId !== null) preparedSessions.add(String(sessionId));
			ctx.logger?.warn?.("worktree: session worktree skipped (%s)", error instanceof Error ? error.message : String(error));
		}
		return next();
	}, { prepend: true });
}

/** Drop workspace rows this plugin used to create. Real repositories stay. */
async function forgetLeakedWorkspaces(ctx) {
	let registry;
	try {
		registry = ctx.get("workspaceRegistry");
	} catch {
		return;
	}
	if (registry === undefined || typeof registry.list !== "function" || typeof registry.delete !== "function") return;
	let items = [];
	try {
		items = registry.list() ?? [];
	} catch {
		return;
	}
	for (const workspace of items) {
		const title = typeof workspace?.title === "string" ? workspace.title : "";
		const wsPath = typeof workspace?.path === "string" ? workspace.path : "";
		const leaked = title.startsWith("[worktree] ") || wsPath.split(/[/\\]/).includes(".dsh-worktrees");
		if (!leaked || workspace.id === undefined) continue;
		try {
			await registry.delete(workspace.id);
		} catch {
			// A leftover row is visible, but it must not stop the plugin.
		}
	}
}

function modeJson(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
	});
}

function registerModeRoute(ctx) {
	ctx.inject(["connection"], (scope) => {
		scope.effect(() => scope.connection.fetch.register({
			path: "/api/vk-bundle/worktrees/mode",
			methods: ["POST"],
			requestBody: "buffered",
			fetch: async (request) => {
				let body = {};
				try {
					const raw = typeof request.text === "function" ? await request.text() : "";
					body = raw === "" ? {} : JSON.parse(raw);
				} catch {
					return modeJson(400, { error: "not JSON" });
				}
				const enabled = body.enabled !== false;
				const repoRoot = typeof body.path === "string" ? body.path : "";
				setSessionWorktreeMode(repoRoot, enabled);
				return modeJson(200, { enabled });
			}
		}), "worktree: mode");
	});
}

/** Render the once-per-session worktree context note. */
function renderWorktreeNote(repoRoot, worktree) {
	const head = worktree.head ?? worktree.baseCommit;
	const where = worktree.branch ? worktree.branch : (head ? `detached @ ${shortSha(head)}` : "unknown");
	return [
		`You are working inside git worktree ${JSON.stringify(worktree.name)} of ${repoRoot}.`,
		`  worktree path: ${worktree.path}`,
		`  HEAD: ${head ?? "unknown"} (${where})`,
		"Manage worktrees with worktree_create / worktree_list / worktree_remove, or the /worktree command."
	].join("\n");
}

/**
 * Announce, once per session, when a session runs inside a linked git
 * worktree (not the main checkout).
 */
function registerContextNote(ctx, manager) {
	/** @type {Map<string, {repoRoot: string, worktree: import("./manager.js").WorktreeEntry}|null>} */
	const lookedUp = new Map();
	const announced = new Set();
	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted) return decision;
		const cwd = agent.session.header.cwd;
		if (typeof cwd !== "string") return decision;
		const sessionId = String(agent.session.id);
		let found = lookedUp.get(sessionId);
		if (found === undefined) {
			found = (await manager.findForCwd(cwd, signal)) ?? null;
			lookedUp.set(sessionId, found);
		}
		if (found === null || announced.has(sessionId)) return decision;
		announced.add(sessionId);
		const text = renderWorktreeNote(found.repoRoot, found.worktree);
		return {
			...decision,
			messages: [...decision.messages, {
				id: crypto.randomUUID(),
				role: "user",
				content: [{ type: "text", text }],
				// Session format v4 rejects kind "plugin". The kind is this producer.
				source: {
					kind: name,
					form: "snapshot",
					sections: [{ name, text }]
				}
			}]
		};
	}, { prepend: true });
}

/**
 * Mount the plugin: worktree service, tools, command, and context note.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {{dirName: string}} config
 */
function apply(ctx, config) {
	const manager = new WorktreeManager(ctx, { dirName: config.dirName });
	ctx.provide("worktree", manager);
	registerTools(ctx, manager);
	registerCommand(ctx, manager);
	registerContextNote(ctx, manager);
	registerSessionWorktree(ctx, manager);
	registerModeRoute(ctx);
	void forgetLeakedWorkspaces(ctx);
}

export { Config, WorktreeManager, WorktreeError, apply, inject, name };
