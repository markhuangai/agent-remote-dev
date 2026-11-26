import { realpathSync } from "node:fs";
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
  const remaining: string[] = [];
  for (;;) {
    try { return resolve(realpathSync.native(current), ...remaining); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      remaining.unshift(basename(current));
      current = parent;
    }
  }
}

export function activityPath(path: string, cwd: string, base = cwd) {
  const root = existingPath(cwd);
  const raw = isAbsolute(path) ? path : `${base}${sep}${path}`;
  const absolute = existingPath(raw);
  const name = relative(resolve(cwd), resolve(base, path));
  const physical = root && absolute ? relative(root, absolute) : "..";
  const escapes = (value: string) => value === ".." || value.startsWith(".." + sep) || isAbsolute(value);
  const outside = escapes(name) || escapes(physical);
  const sensitive = [raw, physical].some(candidate => {
    const segments = candidate.split(/[\\/]/), file = basename(candidate);
    return segments.some(segment => [".ssh", ".aws", ".gnupg"].includes(segment.toLowerCase())) ||
      sensitiveNames.test(file) || sensitiveExtension.test(file) || sensitiveData.test(file) && (!extname(file) || dataExtension.test(extname(file)));
  });
  return { path: outside ? "<outside-workspace>" : name || ".", outside, sensitive };
}

function unwrapCommand(command: string) {
  const wrapper = /^\s*(?:\/(?:usr\/)?bin\/)?(?:bash|sh|zsh)\s+-[a-z]*c\s+(["'])([\s\S]*)\1\s*$/.exec(command);
  return wrapper ? wrapper[2] : command;
}

function commandSegments(command: string, separators?: string[]) {
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
      separators?.push(character === "&" ? "&&" : character);
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
  const separators: string[] = [];
  let base: string | undefined = cwd, found = false, changedDirectory = false;
  for (const [index, segment] of commandSegments(unwrapped, separators).entries()) {
    if (/^apply_patch(?:\s|$)/.test(segment)) { found = true; break; }
    const changeDirectory = /^cd\s+(?:--\s+)?(?:'([^']*)'|"([^"$`\\]*)"|([\w./-]+))$/.exec(segment);
    if (changeDirectory) {
      const directory = changeDirectory[1] ?? changeDirectory[2] ?? changeDirectory[3];
      base = directory === "-" ? undefined : isAbsolute(directory) ? resolve(directory) : base ? resolve(base, directory) : undefined;
      changedDirectory = true;
    } else if (!/^(?:true|false|:|pwd|echo|printf|test)(?:\s|$)/.test(segment) || /[|<>]/.test(segment)) {
      base = undefined;
    }
    if (changedDirectory && separators[index] !== "&&") base = undefined;
  }
  if (!found) return null;
  const edit = (path: string, kind: string, diff?: string) => base
    ? editForPath(path, kind, diff, cwd, base)
    : { path: "<outside-workspace>", kind, suppressed: "working directory unknown" };
  const patch = /\*\*\* Begin Patch\r?\n([\s\S]*?)\r?\n\*\*\* End Patch/.exec(unwrapped)?.[1];
  const edits: ActivityEdit[] = [];
  if (patch) {
    const sections = patch.split(/(?=^\*\*\* (?:Add|Update|Delete) File: )/m);
    for (const section of sections) {
      const header = /^\*\*\* (Add|Update|Delete) File: ([^\r\n]+)/.exec(section);
      if (!header) continue;
      const move = /^\*\*\* Move to: ([^\r\n]+)/m.exec(section);
      if (!move) { edits.push(edit(header[2], header[1].toLowerCase(), section)); continue; }
      const source = edit(header[2], "move"), destination = edit(move[1], "move");
      const suppressed = source.suppressed ?? destination.suppressed;
      edits.push({ path: `${source.path} -> ${destination.path}`, kind: "move", ...(suppressed ? { suppressed } : { diff: section }) });
    }
  } else {
    const lines = output.split(/\r?\n/);
    const start = lines.findIndex(line => line === "Success. Updated the following files:");
    if (start >= 0) for (const line of lines.slice(start + 1)) {
      const entry = /^([AMD])\s+(.+)$/.exec(line);
      if (!entry) break;
      edits.push(edit(entry[2], { A: "add", M: "update", D: "delete" }[entry[1]]!));
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
