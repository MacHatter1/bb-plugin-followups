import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile, symlink, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { maxBuffer: 32 * 1024 * 1024 });
const safePath = (name) => name && !path.isAbsolute(name) && !name.split("/").some((part) => part === ".." || part === "." || part === "");
const excluded = (name) => name.split("/").some((part) => ["node_modules", ".git", ".local", "dist", "build", "coverage"].includes(part) || /^\.env(?:\.|$)/.test(part)) || /\.(?:pem|key)$/.test(name);

/** Freeze before capture: baseline blobs from Git, candidate tracked + nonignored files. */
export async function freezeRevision(root, destination, ref = null, outputDir = null) {
  const realRoot = await realpath(root);
  // Destination is owned scratch space. Existing symlinks must never redirect writes.
  let ancestor = path.resolve(destination);
  while (true) {
    try { if ((await lstat(ancestor)).isSymbolicLink()) throw new Error(`Unsafe destination symlink: ${ancestor}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(ancestor);
    // System temporary-directory aliases (/tmp, /var) are not snapshot contents.
    if (parent === ancestor || parent === "/tmp" || parent === "/var") break;
    ancestor = parent;
  }
  const commit = git(root, ["rev-parse", "--verify", `${ref ?? "HEAD"}^{commit}`]).toString().trim();
  const entries = ref
    ? git(root, ["ls-tree", "-rz", "--full-tree", commit]).toString().split("\0").filter(Boolean).map((row) => {
      const [header, name] = row.split("\t");
      const [mode, type, oid] = header.split(" ");
      return { name, mode, type, oid };
    })
    : [...new Set(git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).toString().split("\0").filter(Boolean))].map((name) => ({ name }));
  await mkdir(destination, { recursive: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const { name } = entry;
    if (!safePath(name)) throw new Error(`Unsafe source path: ${name}`);
    if (excluded(name) || (outputDir && path.resolve(root, name).startsWith(`${path.resolve(outputDir)}${path.sep}`))) continue;
    let bytes;
    if (ref) {
      if (entry.mode === "120000" || entry.type !== "blob") throw new Error(`Unsupported source symlink/submodule: ${name}`);
      bytes = git(root, ["cat-file", "blob", entry.oid]);
    } else {
      let stat;
      try { stat = await lstat(path.join(root, name)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsupported source symlink/file: ${name}`);
      let segmentPath = root;
      for (const segment of name.split("/")) {
        segmentPath = path.join(segmentPath, segment);
        if ((await lstat(segmentPath)).isSymbolicLink()) throw new Error(`Unsupported source symlink ancestor: ${name}`);
      }
      const resolved = await realpath(path.join(root, name));
      if (!resolved.startsWith(`${realRoot}${path.sep}`)) throw new Error(`Source escapes repository: ${name}`);
      bytes = await readFile(path.join(root, name));
    }
    let destinationSegment = destination;
    for (const segment of name.split("/").slice(0, -1)) {
      destinationSegment = path.join(destinationSegment, segment);
      await mkdir(destinationSegment, { recursive: true });
      if ((await lstat(destinationSegment)).isSymbolicLink()) throw new Error(`Unsafe destination symlink: ${name}`);
    }
    try { if ((await lstat(path.join(destination, name))).isSymbolicLink()) throw new Error(`Unsafe destination symlink: ${name}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await writeFile(path.join(destination, name), bytes);
    files.push({ path: name, sha256: hash(bytes), bytes: bytes.length });
  }
  await symlink(path.join(root, "node_modules"), path.join(destination, "node_modules"), "dir");
  return { commit, dirty: ref ? false : git(root, ["status", "--porcelain"]).toString().trim() !== "", sourceHash: hash(JSON.stringify(files)), files };
}

/** Exercise production event/RPC paths, then ask the SDK to normalize own configuration. */
export async function captureCase(revisionDir, entry, config, { configureUnavailable = false } = {}) {
  const { default: plugin } = await import(pathToFileURL(path.join(revisionDir, "server.ts")).href);
  const parent = makeThreadResponse({ id: "parent", status: "idle", projectId: "project", environmentId: "environment", visibility: "visible" });
  const metadata = entry.kind === "expand" ? { status: "ready", suggestions: [{ id: "picked", ...entry.picked }], updatedAt: Date.now() } : {};
  const spawns = [];
  const model = { id: config.model, model: config.model, isDefault: true, routeProviderId: "codex", defaultReasoningEffort: config.reasoning, supportedReasoningEfforts: [{ reasoningEffort: config.reasoning }] };
  const host = createFakePluginHost({
    pluginId: "followups", agentSkillIds: ["followups"], settings: { suggestPrompt: entry.style },
    sdk: {
      threads: {
        getPluginMetadata: async () => metadata,
        updatePluginMetadata: async ({ set }) => { Object.assign(metadata, set); return {}; },
        get: async ({ threadId }) => threadId === "parent" ? parent : makeThreadResponse({ id: threadId, status: "active", visibility: "hidden", projectId: "project", environmentId: "environment" }),
        list: async (args) => args.parentThreadId ? [] : [],
        output: async ({ threadId }) => ({ output: threadId === "parent" ? entry.answer : "" }),
        promptHistory: async () => [...entry.prompts].reverse().map((text) => ({ input: [{ type: "text", text }] })),
        spawn: async (args) => { spawns.push(structuredClone(args)); return { id: "worker" }; },
        stop: async () => ({}), archive: async () => ({}), delete: async () => ({ ok: true }), events: { list: async () => [] },
      },
      system: { executionOptions: async () => ({ models: [model], providers: [{ id: "codex", available: true }] }) },
      providers: { models: async () => ({ models: [model], providers: [{ id: "codex", serviceTiers: [] }] }) },
    },
  });
  if (configureUnavailable) host.bb.agents.configure = () => { throw new Error("configuration unavailable"); };
  let pending;
  try {
    await plugin(host.bb);
    if (entry.kind === "expand") pending = host.harness.callRpc("followups_expand", { threadId: "parent", id: "picked" }).catch(() => {});
    else await host.harness.emitThreadEvent("thread.idle", { thread: parent, lastAssistantText: entry.answer });
    const deadline = Date.now() + 5000;
    while (!spawns.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (spawns.length !== 1) throw new Error(`Expected one production spawn for ${entry.id}; got ${spawns.length}: ${JSON.stringify(host.harness.logEntries)}`);
    const spawn = spawns[0];
    const ownConfiguration = await host.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { title: spawn.title }, pluginMetadata: spawn.pluginMetadata ?? {} }));
    return { caseId: entry.id, prompt: spawn.prompt, instructions: ownConfiguration.instructions ?? null, ownConfiguration, spawn, promptHash: hash(spawn.prompt), instructionsHash: hash(JSON.stringify(ownConfiguration.instructions ?? null)) };
  } finally {
    await host.harness.dispose();
    await pending;
  }
}
