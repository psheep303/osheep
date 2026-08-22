import { JsonlProcessTransport } from "./jsonl-process.js";

/** PTY-compatible process transport. The adapter boundary remains identical to JSONL processes. */
export class PtyTransport extends JsonlProcessTransport {}
