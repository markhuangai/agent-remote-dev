import { cp } from "node:fs/promises";

await cp(new URL("../src/supervise.py", import.meta.url), new URL("../.build/supervise.py", import.meta.url));
await cp(new URL("../src/archive.py", import.meta.url), new URL("../.build/archive.py", import.meta.url));
