import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketOfAddress, canonicalAddress, clientAddress, type ResolvedProxy } from "./proxy.js";

test("an address is read exactly or not at all: one spelling per address, and a port, zone, name, leading zero or range is no address", () => {
  assert.equal(canonicalAddress("203.0.113.9"), "203.0.113.9");
  assert.equal(canonicalAddress(" 203.0.113.9 "), "203.0.113.9");
  assert.equal(canonicalAddress("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(canonicalAddress("::ffff:cb00:7109"), "203.0.113.9");
  assert.equal(canonicalAddress("[2001:DB8:0:0:0:0:0:1]"), "2001:db8::1");
  assert.equal(canonicalAddress("2001:db8::1"), canonicalAddress("2001:0db8:0000::0001"));
  for (const bad of ["", "203.0.113.9:80", "203.0.113.010", "fe80::1%eth0", "host.example", "10.0.0.0/8", "1.2.3", "[1.2.3.4]x", "1.2.3.4, 5.6.7.8", undefined, "a".repeat(100)]) assert.equal(canonicalAddress(bad as never), undefined, String(bad));
});

test("an IPv6 client is one bucket per /64; an IPv4 client is its own", () => {
  assert.equal(bucketOfAddress("2001:db8:1:2::1"), bucketOfAddress("2001:db8:1:2:ffff:ffff:ffff:ffff"));
  assert.notEqual(bucketOfAddress("2001:db8:1:2::1"), bucketOfAddress("2001:db8:1:3::1"));
  assert.equal(bucketOfAddress("::1"), bucketOfAddress("::2"));
  assert.equal(bucketOfAddress("203.0.113.9"), "203.0.113.9");
});

test("the client address: the peer unless the peer is the proxy; then the rightmost entry that is not a proxy; garbled input never chooses an address", () => {
  const proxy: ResolvedProxy = { addresses: new Set(["127.0.0.1", "::1"]), header: "x-forwarded-for" };
  const via = (peer: string | undefined, h: Record<string, string | string[] | undefined>, p = proxy) => clientAddress(peer, h, p).address;
  assert.equal(clientAddress("127.0.0.1", { "x-forwarded-for": "198.51.100.1" }, undefined).address, "127.0.0.1", "no proxy configured: header ignored");
  assert.equal(clientAddress("::ffff:127.0.0.1", { "x-forwarded-for": "198.51.100.1" }, undefined).address, "127.0.0.1");
  assert.equal(via("192.0.2.5", { "x-forwarded-for": "198.51.100.1" }), "192.0.2.5", "peer is not the proxy");
  assert.equal(via("127.0.0.1", { "x-forwarded-for": "198.51.100.1" }), "198.51.100.1");
  assert.equal(via("::ffff:127.0.0.1", { "x-forwarded-for": "198.51.100.1" }), "198.51.100.1", "mapped spelling of the proxy");
  assert.equal(via("127.0.0.1", { "x-forwarded-for": "6.6.6.6, 198.51.100.1" }), "198.51.100.1");
  assert.equal(via("127.0.0.1", { "x-forwarded-for": "6.6.6.6, 198.51.100.1, ::1, 127.0.0.1" }), "198.51.100.1");
  assert.equal(via("127.0.0.1", { "x-forwarded-for": ["6.6.6.6", "198.51.100.1"] }), "198.51.100.1", "lines are one list");
  assert.equal(via("127.0.0.1", { "x-forwarded-for": "127.0.0.1" }), "127.0.0.1", "only proxies listed: the proxy itself");
  assert.equal(via("127.0.0.1", { "x-forwarded-for": "198.51.100.1, garbage" }), "127.0.0.1", "an unreadable hop is not skipped to reach an earlier one");
  assert.equal(via("127.0.0.1", { "x-forwarded-for": "198.51.100.1," }), "127.0.0.1");
  assert.equal(via("127.0.0.1", { "x-forwarded-for": Array.from({ length: 21 }, () => "198.51.100.1").join(",") }), "127.0.0.1");
  assert.equal(via("127.0.0.1", { "x-forwarded-for": "" }), "127.0.0.1");
  assert.equal(via("127.0.0.1", {}), "127.0.0.1");
  assert.equal(via(undefined, { "x-forwarded-for": "198.51.100.1" }), "?");
  const real: ResolvedProxy = { addresses: proxy.addresses, header: "x-real-ip" };
  assert.equal(via("127.0.0.1", { "x-real-ip": "198.51.100.1", "x-forwarded-for": "6.6.6.6" }, real), "198.51.100.1");
  assert.equal(via("127.0.0.1", { "x-real-ip": "198.51.100.1, 6.6.6.6" }, real), "127.0.0.1", "a repeated x-real-ip is not one address");
});
