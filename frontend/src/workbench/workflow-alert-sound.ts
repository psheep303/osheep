let workflowAlertAudioContext: AudioContext | null = null;

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

export function playWorkflowWaitingSound(): void {
  prepareWorkflowAlertSound();
  const audio = workflowAlertAudioContext;
  if (audio?.state !== "running") return;
  const now = audio.currentTime;
  for (const [offset, frequency] of [
    [0, 660],
    [0.16, 880],
  ] as const) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
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
