import { cp } from "node:fs/promises";

await cp(new URL("../src/supervise.py", import.meta.url), new URL("../.build/supervise.py", import.meta.url));
