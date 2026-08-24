import { parseJsonlEvents } from "./events.js";
export function parseClaudeCodeEvents(text: string): unknown[] {
  return parseJsonlEvents(text);
}
