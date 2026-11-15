import { main } from "./main.js";
import { checkpointWorker } from "./checkpoint-worker.js";

if (process.argv[2] === "--checkpoint-worker") void checkpointWorker(process.argv[3]);
else void main();
