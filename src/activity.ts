import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Diagnostics } from "./diagnostics.js";

const commandNames = new Set(["cat", "head", "tail", "sed", "rg", "ls", "find", "pwd", "git", "gh", "npm", "npx", "node",
  "python", "python3", "apply_patch", "make", "cargo", "go", "cd", "set", "printf", "echo", "test", "sleep", "curl", "wget"]);
const sensitiveNames = /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.htpasswd|auth\.json|id_(?:rsa|ed25519|ecdsa).*)$/i;
const sensitiveExtension = /\.(?:pem|key|p8|p12|pfx|jks|keystore)$/i;
const sensitiveData = /(?:secret|credential)/i;
const dataExtension = /^\.(?:json|ya?ml|toml|ini|env|txt|cfg|conf)$/i;

function existingPath(path: string) {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    current = parent;
  }
  try { return resolve(realpathSync(current), relative(current, path)); }
  catch { return path; }
}

export function activityPath(path: string, cwd: string, base = cwd) {
  const root = existingPath(resolve(cwd));
  const absolute = existingPath(resolve(base, path));
  const name = relative(root, absolute);
  const outside = name === ".." || name.startsWith(".." + sep) || isAbsolute(name);
  const segments = name.split(/[\\/]/);
  const file = basename(name);
  const sensitive = segments.some(segment => [".ssh", ".aws", ".gnupg"].includes(segment.toLowerCase())) ||
    sensitiveNames.test(file) || sensitiveExtension.test(file) || sensitiveData.test(file) && (!extname(file) || dataExtension.test(extname(file)));
  return { path: outside ? "<outside-workspace>" : name || ".", outside, sensitive };
}

function unwrapCommand(command: string) {
  const wrapper = /^\s*(?:\/(?:usr\/)?bin\/)?(?:bash|sh|zsh)\s+-[a-z]*c\s+(["'])([\s\S]*)\1\s*$/.exec(command);
  return wrapper ? wrapper[2] : command;
}

function commandSegments(command: string) {
  const result: string[] = [];
  let quote = "", escaped = false, start = 0;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "\n" || character === ";" || character === "&" && command[index + 1] === "&") {
      result.push(command.slice(start, index).trim());
      if (character === "&") index++;
      start = index + 1;
    }
  }
  result.push(command.slice(start).trim());
  return result;
}

export function commandName(command: string) {
  const first = commandSegments(unwrapCommand(command))[0] ?? "";
  const name = /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*([a-z_][a-z0-9_-]*)(?=\s|$)/.exec(first)?.[1];
  return name && commandNames.has(name) ? name : "shell";
}

export function summarizeCommand(command: string, cwd: string) {
  const first = commandSegments(unwrapCommand(command))[0] ?? "";
  const name = commandName(command);
  if (name === "shell") return name;
  const words = first.split(/\s+/);
  const position = words.findIndex(word => word === name);
  const args = words.slice(position + 1);
  const summary = [name];
  if (["git", "gh", "npm", "cargo", "go", "make"].includes(name) && /^[a-z][a-z0-9_-]*$/.test(args[0] ?? "")) {
    summary.push(args.shift()!);
    if (name === "npm" && summary[1] === "run" && /^[a-z0-9:_-]+$/i.test(args[0] ?? "")) summary.push(args.shift()!);
  }
  if (name === "node" && args[0] === "--test") {
    summary.push("--test");
    for (const arg of args.slice(1, 6)) {
      if (!/^[\w./-]+$/.test(arg) || arg.startsWith("-")) break;
      summary.push(activityPath(arg, cwd).path);
    }
  }
  return summary.join(" ");
}

export type ActivityEdit = { path: string; kind: string; diff?: string; suppressed?: string };

export function editForPath(path: string, kind: string, diff: string | undefined, cwd: string, base = cwd): ActivityEdit {
  const result = activityPath(path, cwd, base);
  return { path: result.path, kind, ...(result.outside ? { suppressed: "outside workspace" }
    : result.sensitive ? { suppressed: "sensitive file" } : diff ? { diff } : {}) };
}

export function parseApplyPatch(command: string, output: string, cwd: string): ActivityEdit[] | null {
  const unwrapped = unwrapCommand(command);
  let base = cwd, found = false;
  for (const segment of commandSegments(unwrapped)) {
    const changeDirectory = /^cd\s+([\w./-]+)$/.exec(segment);
    if (changeDirectory) base = resolve(base, changeDirectory[1]);
    if (/^apply_patch(?:\s|$)/.test(segment)) { found = true; break; }
  }
  if (!found) return null;
  const patch = /\*\*\* Begin Patch\r?\n([\s\S]*?)\r?\n\*\*\* End Patch/.exec(unwrapped)?.[1];
  const edits: ActivityEdit[] = [];
  if (patch) {
    const sections = patch.split(/(?=^\*\*\* (?:Add|Update|Delete) File: )/m);
    for (const section of sections) {
      const header = /^\*\*\* (Add|Update|Delete) File: ([^\r\n]+)/.exec(section);
      if (!header) continue;
      edits.push(editForPath(header[2], header[1].toLowerCase(), section, cwd, base));
    }
  } else {
    const lines = output.split(/\r?\n/);
    const start = lines.findIndex(line => line === "Success. Updated the following files:");
    if (start >= 0) for (const line of lines.slice(start + 1)) {
      const entry = /^([AMD])\s+(.+)$/.exec(line);
      if (!entry) break;
      edits.push(editForPath(entry[2], { A: "add", M: "update", D: "delete" }[entry[1]]!, undefined, cwd, base));
    }
  }
  return edits;
}

export function boundedLines(value: string, limit = 12000) {
  const lines: string[] = [];
  let bytes = 0;
  for (const line of value.split("\n")) {
    const safe = Buffer.byteLength(line) > 4096 ? "[oversized line omitted]" : line;
    const size = Buffer.byteLength(safe) + 1;
    if (bytes + size > limit) { lines.push("[remaining lines omitted]"); break; }
    lines.push(safe); bytes += size;
  }
  return lines;
}

export function showEdit(log: Diagnostics, edit: ActivityEdit) {
  log.line(`[edit] ${edit.kind} ${edit.path}${edit.suppressed ? ` (${edit.suppressed})` : ""}`);
  if (edit.diff && !edit.suppressed) log.group(`Diff ${edit.path}`, boundedLines(log.redact(edit.diff)), { untrusted: true });
}
