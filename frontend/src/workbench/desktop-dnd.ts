import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";

export interface DesktopDropPayload {
  paths: string[];
  position?: { x: number; y: number };
}

export const DESKTOP_EXTERNAL_DROP_EVENT = "osheep-desktop-external-drop";

export function elementsAtDesktopDropPosition(
  position: DesktopDropPayload["position"],
): Element[] {
  if (!position || typeof document === "undefined") return [];
  const scale = window.devicePixelRatio || 1;
  const candidates = [
    [position.x, position.y],
    [position.x / scale, position.y / scale],
    [position.x - window.screenX, position.y - window.screenY],
    [(position.x - window.screenX) / scale, (position.y - window.screenY) / scale],
  ];
  const elements: Element[] = [];
  for (const [x, y] of candidates) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const element = document.elementFromPoint(x, y);
    if (element && !elements.includes(element)) elements.push(element);
  }
  return elements;
}

export async function listenDesktopFileDrop(
  handler: (payload: DesktopDropPayload) => void,
): Promise<UnlistenFn | null> {
  if (!isTauri()) return null;
  return await listen<DesktopDropPayload>("tauri://drag-drop", (event) => {
    const paths = Array.isArray(event.payload?.paths)
      ? event.payload.paths.filter((path): path is string => typeof path === "string" && path.length > 0)
      : [];
    if (paths.length > 0) handler({ paths, position: event.payload?.position });
  });
}
