import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  type AgentSessionRoots,
  deleteAgentSession,
  deleteAgentSessionsInProject,
  isAgentSessionInProject,
  listAgentSessions,
  readAgentSessionUsage,
  reassignCodexSessionId,
} from "./agent-sessions.js";

test("Codex sessions can be persisted under a requested UUID", async () => {
  const fixture = await makeFixture();
  const currentId = "10000000-2222-4333-8444-555555555555";
  const requestedId = "20000000-2222-4333-8444-555555555555";
  const currentFile = codexSessionPath(fixture.roots, currentId, "09-00-00");
  try {
    await writeLines(currentFile, [codexMetadata(currentId, fixture.projectPath)]);
    await reassignCodexSessionId(currentId, requestedId, fixture.roots);

    const sessions = await listAgentSessions("codex", fixture.roots);
    assert.deepEqual(sessions.map((session) => session.id), [requestedId]);
    await assert.rejects(fs.stat(currentFile));
    const text = await fs.readFile(
      codexSessionPath(fixture.roots, requestedId, "09-00-00"),
      "utf8",
    );
    assert.match(text, new RegExp(requestedId));
    assert.doesNotMatch(text, new RegExp(currentId));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("project scope filters sessions and batch delete rejects sibling projects", async () => {
  const fixture = await makeFixture();
  const currentId = "10000000-2222-4333-8444-555555555555";
  const siblingId = "20000000-2222-4333-8444-555555555555";
  const siblingPath = path.join(fixture.root, "sibling-project");
  const currentFile = codexSessionPath(fixture.roots, currentId, "10-00-00");
  const siblingFile = codexSessionPath(fixture.roots, siblingId, "11-00-00");
  try {
    await fs.mkdir(siblingPath, { recursive: true });
    await writeLines(currentFile, [codexMetadata(currentId, fixture.projectPath)]);
    await writeLines(siblingFile, [codexMetadata(siblingId, siblingPath)]);

    const sessions = await listAgentSessions("codex", fixture.roots);
    const visible = sessions.filter((session) =>
      isAgentSessionInProject(session, fixture.projectPath),
    );
    assert.deepEqual(
      visible.map((session) => session.id),
      [currentId],
    );

    const result = await deleteAgentSessionsInProject(
      "codex",
      [currentId, siblingId],
      fixture.projectPath,
      fixture.roots,
    );
    assert.deepEqual(
      result.deleted.map((session) => session.id),
      [currentId],
    );
    assert.deepEqual(
      result.failed.map((failure) => failure.id),
      [siblingId],
    );
    await assert.rejects(fs.stat(currentFile), { code: "ENOENT" });
    assert.equal((await fs.stat(siblingFile)).isFile(), true);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("Codex sessions use metadata, prompt text, and the title index", async () => {
  const fixture = await makeFixture();
  const id = "11111111-2222-4333-8444-555555555555";
  const sessionPath = path.join(
    fixture.roots.codexHome,
    "sessions",
    "2026",
    "07",
    "17",
    `rollout-2026-07-17T10-00-00-${id}.jsonl`,
  );
  try {
    await writeLines(sessionPath, [
      {
        timestamp: "2026-07-17T02:00:00.000Z",
        type: "session_meta",
        payload: { id, cwd: fixture.projectPath },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "<environment_context>ignored</environment_context>Implement sessions",
        },
      },
    ]);
    await writeLines(path.join(fixture.roots.codexHome, "session_index.jsonl"), [
      {
        id,
        thread_name: "Indexed Codex title",
        updated_at: "2026-07-17T03:00:00.000Z",
      },
    ]);

    const sessions = await listAgentSessions("codex", fixture.roots);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, id);
    assert.equal(sessions[0].title, "Indexed Codex title");
    assert.equal(sessions[0].cwd, fixture.projectPath);

    const deleted = await deleteAgentSession("codex", id, fixture.roots);
    assert.equal(deleted?.id, id);
    await assert.rejects(fs.stat(sessionPath), { code: "ENOENT" });
    assert.doesNotMatch(
      await fs.readFile(path.join(fixture.roots.codexHome, "session_index.jsonl"), "utf8"),
      new RegExp(id),
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("Codex session usage reads the last cumulative token_count event", async () => {
  const fixture = await makeFixture();
  const id = "31111111-2222-4333-8444-555555555555";
  const sessionPath = codexSessionPath(fixture.roots, id, "12-00-00");
  try {
    await writeLines(sessionPath, [
      codexMetadata(id, fixture.projectPath),
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1_000,
              cached_input_tokens: 700,
              cache_write_input_tokens: 50,
              output_tokens: 100,
              total_tokens: 1_100,
            },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 2_000,
              cached_input_tokens: 1_400,
              cache_write_input_tokens: 75,
              output_tokens: 250,
              total_tokens: 2_250,
            },
          },
        },
      },
    ]);

    assert.deepEqual(await readAgentSessionUsage("codex", id, fixture.roots), {
      tokens: {
        input: 2_000,
        output: 250,
        cacheRead: 1_400,
        cacheWrite: 75,
        total: 2_250,
      },
      cost: undefined,
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("Claude session usage sums assistant message usage", async () => {
  const fixture = await makeFixture();
  const id = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const sessionPath = path.join(
    fixture.roots.claudeHome,
    "projects",
    "fixture-project",
    `${id}.jsonl`,
  );
  try {
    await writeLines(sessionPath, [
      {
        type: "user",
        sessionId: id,
        cwd: fixture.projectPath,
        message: { role: "user", content: "Measure usage" },
      },
      {
        type: "assistant",
        sessionId: id,
        message: {
          role: "assistant",
          model: "gpt-5.6-sol",
          usage: {
            input_tokens: 600,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 40,
            output_tokens: 80,
          },
        },
      },
      {
        type: "assistant",
        sessionId: id,
        message: {
          role: "assistant",
          model: "gpt-5.6-sol",
          usage: {
            input_tokens: 400,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 60,
            output_tokens: 120,
          },
        },
      },
    ]);

    assert.deepEqual(await readAgentSessionUsage("claude", id, fixture.roots), {
      model: "gpt-5.6-sol",
      tokens: {
        input: 1_000,
        output: 200,
        cacheRead: 500,
        cacheWrite: 100,
        total: 1_800,
      },
      cost: undefined,
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("Claude session usage reads nested cache creation buckets", async () => {
  const fixture = await makeFixture();
  const id = "cccccccc-dddd-4eee-8fff-111111111111";
  const sessionPath = path.join(
    fixture.roots.claudeHome,
    "projects",
    "fixture-project",
    `${id}.jsonl`,
  );
  try {
    await writeLines(sessionPath, [
      {
        type: "assistant",
        sessionId: id,
        cwd: fixture.projectPath,
        message: {
          role: "assistant",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation: {
              ephemeral_5m_input_tokens: 30,
              ephemeral_1h_input_tokens: 20,
            },
          },
        },
      },
    ]);
    assert.equal(
      (await readAgentSessionUsage("claude", id, fixture.roots)).tokens?.cacheWrite,
      50,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("Codex session usage accumulates cache writes reported per turn", async () => {
  const fixture = await makeFixture();
  const id = "41111111-2222-4333-8444-555555555555";
  const sessionPath = codexSessionPath(fixture.roots, id, "13-00-00");
  try {
    await writeLines(sessionPath, [
      codexMetadata(id, fixture.projectPath),
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 100, output_tokens: 10 },
            last_token_usage: { cacheCreationInputTokens: 25 },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 200, output_tokens: 20 },
            last_token_usage: { cache_write_tokens: 35 },
          },
        },
      },
    ]);
    assert.equal(
      (await readAgentSessionUsage("codex", id, fixture.roots)).tokens?.cacheWrite,
      60,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("Claude session deletion removes transcript artifacts and index entries", async () => {
  const fixture = await makeFixture();
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const projectDir = path.join(fixture.roots.claudeHome, "projects", "fixture-project");
  const sessionPath = path.join(projectDir, `${id}.jsonl`);
  const auxiliaryPath = path.join(projectDir, id);
  const indexPath = path.join(projectDir, "sessions-index.json");
  try {
    await writeLines(sessionPath, [
      {
        type: "user",
        sessionId: id,
        cwd: fixture.projectPath,
        timestamp: "2026-07-17T04:00:00.000Z",
        message: { role: "user", content: "Add session management" },
      },
    ]);
    await fs.mkdir(auxiliaryPath, { recursive: true });
    await fs.writeFile(path.join(auxiliaryPath, "artifact.txt"), "artifact", "utf8");
    await fs.writeFile(
      indexPath,
      JSON.stringify({
        version: 1,
        entries: [
          { sessionId: id, summary: "Add session management" },
          { sessionId: "ffffffff-1111-4222-8333-444444444444", summary: "Keep me" },
        ],
      }),
      "utf8",
    );

    const sessions = await listAgentSessions("claude", fixture.roots);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].title, "Add session management");
    assert.equal(sessions[0].cwd, fixture.projectPath);

    const deleted = await deleteAgentSession("claude", id, fixture.roots);
    assert.equal(deleted?.id, id);
    await assert.rejects(fs.stat(sessionPath), { code: "ENOENT" });
    await assert.rejects(fs.stat(auxiliaryPath), { code: "ENOENT" });
    const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
      entries: Array<{ sessionId: string }>;
    };
    assert.deepEqual(
      index.entries.map((entry) => entry.sessionId),
      ["ffffffff-1111-4222-8333-444444444444"],
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

async function makeFixture(): Promise<{
  root: string;
  roots: AgentSessionRoots;
  projectPath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-agent-sessions-"));
  const projectPath = path.join(root, "project");
  await fs.mkdir(projectPath, { recursive: true });
  return {
    root,
    projectPath,
    roots: {
      claudeHome: path.join(root, ".claude"),
      codexHome: path.join(root, ".codex"),
    },
  };
}

async function writeLines(filePath: string, values: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
    "utf8",
  );
}

function codexSessionPath(roots: AgentSessionRoots, id: string, time: string): string {
  return path.join(
    roots.codexHome,
    "sessions",
    "2026",
    "07",
    "17",
    `rollout-2026-07-17T${time}-${id}.jsonl`,
  );
}

function codexMetadata(id: string, cwd: string): unknown {
  return {
    timestamp: "2026-07-17T02:00:00.000Z",
    type: "session_meta",
    payload: { id, cwd },
  };
}
