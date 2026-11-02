import { parentPort, workerData } from 'node:worker_threads';
import { digestHeldFile } from './file-digest.ts';

// One file per worker. The read blocks this thread only, so the controller's loop keeps running.
const { path, identity } = workerData as { path: string; identity: string };
parentPort?.postMessage(digestHeldFile(path, identity));
