import assert from "node:assert/strict";
import test from "node:test";
import {
  type RemoteMcpDnsResolver,
  resolveRemoteMcpEndpoint,
  resolveRemoteMcpTarget,
} from "./remote-mcp.js";

function resolver(...addresses: string[]): RemoteMcpDnsResolver {
  return async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
}

test("Remote MCP accepts an HTTPS host that resolves only to public addresses", async () => {
  const target = await resolveRemoteMcpTarget(
    "https://mcp.example.com/rpc?token=public",
    resolver("93.184.216.34"),
  );
  assert.equal(target.url.hostname, "mcp.example.com");
  assert.equal(target.address, "93.184.216.34");
  assert.equal(target.family, 4);
});

test("Remote MCP rejects non-HTTPS and credential-bearing URLs", async () => {
  await assert.rejects(
    resolveRemoteMcpTarget("http://mcp.example.com", resolver("93.184.216.34")),
    /must use https/,
  );
  await assert.rejects(
    resolveRemoteMcpTarget("https://user:secret@mcp.example.com", resolver("93.184.216.34")),
    /must not include credentials/,
  );
});

test("Remote MCP rejects loopback, private, link-local, metadata, and reserved addresses", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.8",
    "172.16.0.8",
    "192.168.1.8",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::7f00:1",
    "2001::1",
    "2002:7f00:1::",
    "fe80::1",
    "fd00::1",
    "2001:db8::1",
  ]) {
    await assert.rejects(
      resolveRemoteMcpTarget("https://mcp.example.com", resolver(address)),
      /public IP addresses/,
      address,
    );
  }

  await assert.rejects(resolveRemoteMcpTarget("https://2130706433"), /public IP addresses/);
});

test("Remote MCP rejects a hostname when any DNS answer is non-public", async () => {
  await assert.rejects(
    resolveRemoteMcpTarget("https://mcp.example.com", resolver("93.184.216.34", "127.0.0.1")),
    /public IP addresses/,
  );
});

test("Remote MCP endpoint remains on the validated origin", () => {
  assert.equal(
    resolveRemoteMcpEndpoint(
      "https://mcp.example.com/events?token=public",
      "/messages?session=one",
    ),
    "https://mcp.example.com/messages?session=one&token=public",
  );
  assert.throws(
    () => resolveRemoteMcpEndpoint("https://mcp.example.com/events", "https://127.0.0.1/rpc"),
    /endpoint URL is invalid/,
  );
});
