export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export const WORKFLOW_AGENT_TERMINAL_SAFE_ROWS = 1;

export interface TerminalUserInputGate {
  markKey: (data: string) => void;
  markNextData: () => void;
  accept: (data: string) => boolean;
}

export function createTerminalUserInputGate(): TerminalUserInputGate {
  const pendingKeys: string[] = [];
  let acceptNextData = false;
  return {
    markKey(data) {
      if (!data) return;
      pendingKeys.push(data);
      if (pendingKeys.length > 16) pendingKeys.shift();
    },
    markNextData() {
      acceptNextData = true;
    },
    accept(data) {
      if (pendingKeys[0] === data) {
        pendingKeys.shift();
        return true;
      }
      if (acceptNextData) {
        acceptNextData = false;
        return true;
      }
      return false;
    },
  };
}

export function workflowAgentTerminalDimensions(
  proposed: TerminalDimensions | undefined,
): TerminalDimensions | null {
  if (!proposed || proposed.cols < 20 || proposed.rows < 4) return null;
  return {
    cols: proposed.cols,
    rows: Math.max(3, proposed.rows - WORKFLOW_AGENT_TERMINAL_SAFE_ROWS),
  };
}
