let workflowAlertAudioContext: AudioContext | null = null;

export type WorkflowAlertSound = "node-success" | "node-error" | "waiting" | "run-completed";

export function prepareWorkflowAlertSound(): void {
  try {
    workflowAlertAudioContext ??= new AudioContext();
    if (workflowAlertAudioContext.state === "suspended") {
      void workflowAlertAudioContext.resume();
    }
  } catch {
    // Web Audio may be unavailable or blocked by browser policy.
  }
}

export function playWorkflowAlertSound(kind: WorkflowAlertSound): void {
  prepareWorkflowAlertSound();
  const audio = workflowAlertAudioContext;
  if (audio?.state !== "running") return;
  const now = audio.currentTime;
  const notes: ReadonlyArray<readonly [number, number]> =
    kind === "node-success"
      ? [
          [0, 660],
          [0.1, 880],
        ]
      : kind === "node-error"
        ? [
            [0, 330],
            [0.12, 220],
          ]
        : kind === "run-completed"
          ? [
              [0, 523],
              [0.1, 659],
              [0.2, 784],
            ]
          : [
              [0, 660],
              [0.16, 880],
            ];
  for (const [offset, frequency] of notes) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = kind === "node-error" ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(frequency, now + offset);
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.13);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(now + offset);
    oscillator.stop(now + offset + 0.14);
  }
}
