import assert from "node:assert/strict";
import test from "node:test";
import {
  attachFileResponse,
  completeFileOpenTrace,
  type FileOpenTrace,
} from "./file-open-performance.ts";

test("file-open metrics split the request into the four P0 phases", () => {
  const trace: FileOpenTrace = {
    id: "trace-test-four-phases",
    clickedAt: 100,
    cacheStatus: "unknown",
  };
  const withResponse = attachFileResponse(
    trace,
    {
      headers: new Headers({
        "server-timing": "osheep-file-read;dur=12.5",
        "x-osheep-file-cache": "miss",
        "x-osheep-file-io-diagnostic": "slow-sync",
      }),
      requestStartedAt: 110,
      headersReceivedAt: 145,
      bodyReceivedAt: 150,
      revalidated: false,
    },
    1024,
  );
  const originalInfo = console.info;
  console.info = () => undefined;
  try {
    assert.deepEqual(completeFileOpenTrace(withResponse, 180), {
      event: "file_open_interactive",
      traceId: "trace-test-four-phases",
      fileSizeBytes: 1024,
      cacheStatus: "miss",
      ioDiagnostic: "slow-sync",
      clickToRequestMs: 10,
      serverRequestToReadCompleteMs: 12.5,
      readCompleteToBrowserMs: 27.5,
      browserReceiveToInteractiveMs: 30,
      totalMs: 80,
    });
    assert.equal(completeFileOpenTrace(withResponse, 200), null);
  } finally {
    console.info = originalInfo;
  }
});

test("incomplete traces are not reported", () => {
  assert.equal(
    completeFileOpenTrace(
      { id: "trace-test-incomplete", clickedAt: 0, cacheStatus: "unknown" },
      10,
    ),
    null,
  );
});

test("file-open response metadata preserves bypass cache status", () => {
  const trace = attachFileResponse(
    { id: "trace-test-bypass", clickedAt: 0, cacheStatus: "unknown" },
    {
      headers: new Headers({
        "server-timing": "osheep-file-read;dur=1",
        "x-osheep-file-cache": "bypass",
        "x-osheep-file-io-diagnostic": "normal",
      }),
      requestStartedAt: 1,
      headersReceivedAt: 2,
      bodyReceivedAt: 3,
      revalidated: false,
    },
    2 * 1024 * 1024,
  );

  assert.equal(trace.cacheStatus, "bypass");
  assert.equal(trace.ioDiagnostic, "normal");
});

test("file-open response metadata rejects missing or invalid diagnostic labels", () => {
  const metadata = {
    headers: new Headers({ "x-osheep-file-io-diagnostic": "slow-cloud" }),
    requestStartedAt: 1,
    headersReceivedAt: 2,
    bodyReceivedAt: 3,
    revalidated: false,
  };
  const invalid = attachFileResponse(
    { id: "trace-test-invalid-diagnostic", clickedAt: 0, cacheStatus: "unknown" },
    metadata,
    1,
  );
  const missing = attachFileResponse(
    { id: "trace-test-missing-diagnostic", clickedAt: 0, cacheStatus: "unknown" },
    { ...metadata, headers: new Headers() },
    1,
  );

  assert.equal(invalid.ioDiagnostic, "unknown");
  assert.equal(missing.ioDiagnostic, "unknown");
});
