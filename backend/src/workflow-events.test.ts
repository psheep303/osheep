import assert from "node:assert/strict";
import test from "node:test";
import { publishWorkflowRuntime, subscribeWorkflowRuntime } from "./workflow-events.js";

test("workflow runtime events stay scoped and unsubscribe cleanly", () => {
  const received: string[] = [];
  const unsubscribe = subscribeWorkflowRuntime("C:/workspace", "wf_12345678", (event) => {
    received.push(event.type);
  });

  publishWorkflowRuntime("C:/other", "wf_12345678", { type: "ready", updatedAt: 1 });
  publishWorkflowRuntime("C:/workspace", "wf_12345678", { type: "ready", updatedAt: 2 });
  unsubscribe();
  publishWorkflowRuntime("C:/workspace", "wf_12345678", { type: "ready", updatedAt: 3 });

  assert.deepEqual(received, ["ready"]);
});

test("a failing workflow runtime observer does not block other observers", () => {
  const received: string[] = [];
  const unsubscribeFailing = subscribeWorkflowRuntime("C:/workspace", "wf_12345678", () => {
    throw new Error("socket closed");
  });
  const unsubscribeHealthy = subscribeWorkflowRuntime(
    "C:/workspace",
    "wf_12345678",
    (event) => received.push(event.type),
  );

  publishWorkflowRuntime("C:/workspace", "wf_12345678", { type: "ready", updatedAt: 1 });
  unsubscribeFailing();
  unsubscribeHealthy();

  assert.deepEqual(received, ["ready"]);
});
