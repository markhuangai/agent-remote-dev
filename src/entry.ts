import { checkpointWorker, watchSnapshots } from "./checkpoint-worker.js";
const operation = process.argv[2] === "--watch" ? watchSnapshots : checkpointWorker;
operation(process.argv[3]).catch(() => { process.stderr.write("Snapshot worker failed.\n"); process.exitCode = 1; });
