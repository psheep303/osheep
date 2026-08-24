# Build An Osheep Adapter

This guide explains how to connect an agent or harness to Osheep with the smallest possible
implementation. It describes the adapter APIs currently available in this repository. An adapter
owns the agent-specific process or API details; Workflow Engine only sees an `AgentAdapter`, an
`AdapterSession`, and normalized `AdapterEvent` values.

## What You Implement

For a JSONL command-line agent, the minimum is:

1. An `AdapterEventMapper` that converts the agent's native JSONL messages into Osheep events.
2. An adapter class extending `JsonlAgentAdapter`.
3. A registry entry in `backend/src/adapters/default-registry.ts`.

Usage reporting is optional. A custom `AdapterUsageProvider` can be added later without changing
Workflow Engine code.

The adapter package must not import React components, Workflow tabs, workflow file formats, or UI
state. Keep those concerns outside the adapter.

## The Runtime Boundary

```text
Workflow Engine
      |
AgentAdapter / AdapterSession
      |
JsonlAgentAdapter + AdapterRuntime
      |---------------------|
AgentTransport          EventMapper
      |                     |
CLI / HTTP / SDK        native events -> AdapterEvent
```

`AgentTransport` starts and controls the underlying process or stream. `AdapterEventMapper` parses
native chunks and emits Osheep events. Unknown native messages should become diagnostics or be
ignored; they must not crash a session.

## Imports

Adapters currently live in the backend source tree. Import the public adapter surface from:

```ts
import {
  JsonlAgentAdapter,
  JsonlDecoder,
  JsonlProcessTransport,
  createAdapterEvent,
  type AdapterCapabilities,
  type AdapterConfigSchema,
  type AdapterEventMapper,
} from "./adapters/index.js";
```

When the standalone SDK package is published, the same imports should come from
`@osheep/adapter-sdk`; the interfaces and lifecycle described below remain the contract.

## Minimal JSONL Example

Assume the agent command is `acme-agent`. It accepts one prompt per JSONL input line and writes
messages such as:

```json
{"type":"text_delta","text":"Hello"}
{"type":"tool_start","name":"shell","id":"call-1"}
{"type":"tool_end","name":"shell","id":"call-1","ok":true}
{"type":"done"}
```

### 1. Map native events

`parse()` receives arbitrary transport chunks, not necessarily complete lines. Use
`JsonlDecoder` so split lines and multiple events per chunk work correctly.

```ts
import {
  JsonlDecoder,
  createAdapterEvent,
  type AdapterEvent,
  type AdapterEventMapper,
  type EventMapperContext,
} from "./adapters/index.js";

type NativeEvent = {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  ok?: boolean;
  error?: string;
};

export class AcmeEventMapper implements AdapterEventMapper<NativeEvent> {
  private readonly decoder = new JsonlDecoder<NativeEvent>();

  parse(chunk: string): NativeEvent[] {
    return this.decoder.push(chunk);
  }

  flush(context: EventMapperContext): AdapterEvent[] {
    return this.decoder.flush().flatMap((event) => this.map(event, context));
  }

  map(event: NativeEvent, context: EventMapperContext): AdapterEvent[] {
    const base = { sessionId: context.sessionId, adapterId: context.adapterId };
    switch (event.type) {
      case "text_delta":
        return [
          createAdapterEvent(base, "assistant.delta", { content: event.text ?? "" }, context.nextSequence()),
        ];
      case "tool_start":
        return [
          createAdapterEvent(
            base,
            "tool.started",
            { toolName: event.name ?? "unknown", callId: event.id ?? "unknown" },
            context.nextSequence(),
          ),
        ];
      case "tool_end":
        return [
          createAdapterEvent(
            base,
            "tool.completed",
            {
              toolName: event.name ?? "unknown",
              callId: event.id ?? "unknown",
              success: event.ok === true,
            },
            context.nextSequence(),
          ),
        ];
      case "done":
        return [createAdapterEvent(base, "agent.completed", { state: "completed" }, context.nextSequence())];
      case "error":
        return [
          createAdapterEvent(
            base,
            "agent.failed",
            { state: "failed", error: event.error ?? "Agent failed" },
            context.nextSequence(),
          ),
        ];
      default:
        return [
          createAdapterEvent(
            base,
            "adapter.diagnostic",
            { message: `Unknown native event: ${event.type ?? "missing type"}` },
            context.nextSequence(),
          ),
        ];
    }
  }
}
```

`flush()` is important when the process exits with a final unterminated line. If the native
protocol is not JSONL, replace `JsonlDecoder` with a protocol-specific incremental parser while
keeping the same `parse/map/flush` interface.

### 2. Define the adapter

```ts
import {
  JsonlAgentAdapter,
  JsonlProcessTransport,
  type AdapterCapabilities,
  type AdapterConfigSchema,
  type AdapterConfig,
  type AdapterStartInput,
  type TransportStartInput,
} from "./adapters/index.js";
import { AcmeEventMapper } from "./acme-mapper.js";

export class AcmeAgentAdapter extends JsonlAgentAdapter {
  readonly id = "acme.agent";
  readonly name = "Acme Agent";
  readonly version = "1.0.0";
  readonly mapper = new AcmeEventMapper();
  readonly transport = new JsonlProcessTransport({
    command: "acme-agent",
    // Add the native resume flag only if the agent really supports resume.
    resumeArgs: (sessionId) => ["--resume", sessionId],
  });

  getCapabilities(): AdapterCapabilities {
    return {
      streaming: true,
      structuredEvents: true,
      session: true,
      resume: true,
      multiTurn: false,
      approval: "none",
      interruption: "hard",
      transport: "pty",
      modelSelection: true,
      workingDirectory: true,
      usage: false,
    };
  }

  getConfigSchema(): AdapterConfigSchema {
    return {
      fields: [
        { key: "model", label: "Model", type: "text", defaultValue: "default" },
        { key: "workingDirectory", label: "Working Directory", type: "text" },
        { key: "apiKey", label: "API Key", type: "text", required: true, secret: true },
      ],
    };
  }

  transportInput(input: AdapterStartInput, config: AdapterConfig): TransportStartInput {
    const base = super.transportInput(input, config);
    return {
      ...base,
      args: ["--model", config.model ?? "default"],
      env: {
        ...base.env,
        ACME_API_KEY:
          typeof (config as AdapterConfig & { apiKey?: unknown }).apiKey === "string"
            ? (config as AdapterConfig & { apiKey: string }).apiKey
            : undefined,
      },
    };
  }
}
```

The adapter ID is a stable identifier, not a display name. It must match the registry format
`[a-z0-9]+(?:[._-][a-z0-9]+)*`; `acme.agent` is valid. `version` is shown by the adapter API and
should change when the adapter contract changes.

If resume is unsupported, set `resume: false` and do not provide fake resume behavior. The base
class returns the standard `UNSUPPORTED` error.

### 3. Register it

Add the adapter to `createDefaultAdapterRegistry()`:

```ts
import { AcmeAgentAdapter } from "./acme-agent-adapter.js";

export function createDefaultAdapterRegistry(): AdapterRegistryImpl {
  const registry = new AdapterRegistryImpl();
  registry.register(new ClaudeCodeAdapter());
  registry.register(new CodexAdapter());
  registry.register(new AcmeAgentAdapter());
  return registry;
}
```

The current repository uses built-in registration. A third-party package is not loaded merely by
placing files in the workspace; it must be installed through an explicitly supported loader and
registered in an allowlist.

## Capabilities and Configuration

Capabilities are structured values consumed by generic code:

| Field | Values | Meaning |
| --- | --- | --- |
| `approval` | `none`, `manual`, `native` | How approval is represented |
| `interruption` | `none`, `soft`, `hard` | Whether and how a turn can be interrupted |
| `transport` | `pty`, `http`, `sdk`, `hybrid` | Underlying transport |
| `session`, `resume`, `multiTurn` | boolean | Session lifecycle support |
| `streaming`, `structuredEvents`, `usage` | boolean | Data and usage support |

Config schemas describe fields, not CLI flags. The adapter converts config into command arguments,
HTTP bodies, or SDK calls in `transportInput()` or a custom transport. Mark credentials with
`secret: true`. Do not put secrets into events, error messages, session metadata, or workflow
output.

## Lifecycle and Events

Every event has this envelope:

```ts
{
  id: string;
  sequence: number;
  timestamp: number;
  sessionId: string;
  adapterId: string;
  type: string;
}
```

Use `context.nextSequence()` for every event emitted by a mapper. The core event types are:

- `session.started`, `session.resumed`, `session.interrupted`, `session.stopped`, `session.closed`
- `assistant.delta`, `assistant.message`
- `tool.started`, `tool.completed`
- `approval.required`, `approval.resolved`
- `agent.waiting`, `agent.completed`, `agent.failed`
- `adapter.diagnostic`

`adapter.frame` is reserved for low-level transport diagnostics. Workflow logic should depend on
the normalized events above, not native event names or terminal text.

## Choosing a Transport

Use the smallest matching transport:

- `JsonlProcessTransport`: a child process with JSONL stdin/stdout.
- `PtyTransport`: a process transport with the same adapter boundary for a terminal-oriented
  command. It does not turn terminal text into business events; map structured native output when
  available.
- `HttpTransport`: a streaming HTTP response. It is read-only after start; `send()` returns the
  standard `UNSUPPORTED` error.
- `SdkTransport`: wraps a local Node SDK or another in-process implementation.

If none fit, implement `AgentTransport` with `start`, `resume`, `send`, `interrupt`, `stop`,
`subscribe`, and `wait`. Do not access `node-pty`, HTTP responses, or file watchers from Workflow
Engine code.

## Usage Reporting (Optional)

Implement `AdapterUsageProvider` when the agent exposes token or cost data:

```ts
import type { AdapterUsageProvider, AgentUsage, UsageInput } from "./adapters/index.js";

export class AcmeUsageProvider implements AdapterUsageProvider {
  async readSessionUsage(input: UsageInput): Promise<AgentUsage> {
    // Read only the agent's session metadata and return normalized values.
    return { model: String(input.config?.model ?? "default") };
  }
}
```

Adapters without usage support return `{}` and leave cost calculation to Osheep.

## Contract Tests

Run the shared checks from your adapter test suite:

```ts
import { createAdapterContractTests } from "./adapters/index.js";
import { AcmeAgentAdapter } from "./acme-agent-adapter.js";

test("Acme adapter contract", createAdapterContractTests({
  create: () => new AcmeAgentAdapter(),
  capabilities: { streaming: true, structuredEvents: true, session: true },
}));
```

Add mapper tests for split chunks, multiple events in one chunk, blank lines, malformed JSON,
unknown event types, and secret/error redaction. Add a process test proving that `interrupt()` and
`stop()` do not leave a child process running.

Recommended acceptance checks:

- `start()` creates one Osheep session with a stable `sessionId`.
- The first turn emits `session.started` and then `agent.completed` or `agent.failed`.
- Unsupported resume returns `AdapterError` with code `UNSUPPORTED`.
- Every event has a monotonically increasing sequence number and the same session envelope.
- Unknown native events produce diagnostics without collapsing the session.
- Credentials never appear in event payloads or error text.
- `npm run typecheck`, `npm test`, and `npm run lint` pass.

## Errors and Debugging

Use `AdapterError` with one of the standard codes: `START_FAILED`, `SEND_FAILED`,
`PROCESS_EXITED`, `SESSION_NOT_FOUND`, `UNSUPPORTED`, `TIMEOUT`, `INTERRUPTED`,
`PERMISSION_DENIED`, `INVALID_CONFIG`, or `UNKNOWN`. Include `adapterId`, `sessionId`,
`retryable`, and the original `cause` where applicable.

For runtime inspection, connect to `/api/adapter-events`. The initial `ready` message includes
active sessions and a bounded recent event history. Filter by workspace on the route when using the
UI. Keep diagnostic messages safe to display; redact API keys, tokens, passwords, and absolute paths.

## Checklist

- [ ] Stable adapter ID, name, and version
- [ ] Complete structured capabilities
- [ ] Config schema with `secret` fields marked
- [ ] Transport isolated from Workflow Engine
- [ ] Incremental mapper with `flush()` support
- [ ] Normalized lifecycle, assistant, tool, approval, and failure events
- [ ] Unsupported capabilities return standard `AdapterError` values
- [ ] Contract tests and mapper edge-case tests
- [ ] Registration in an explicit adapter registry/allowlist
- [ ] README describing the native command, permissions, and required configuration
