import { parseJsonlEvents } from "./events.js";
export function parseCodexEvents(text: string): unknown[] {
  return parseJsonlEvents(text);
}
