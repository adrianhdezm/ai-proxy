// Ported from: sdk/cliproxy/rtprovider_test.go
// Skipped cases: none. Go checks that RoundTripperFor(auth with proxy_url "direct") returns a transport
//   without a Proxy func; Bun has no transports, so withProxy (the per-request proxy option) is checked.
import { expect, test } from "bun:test";
import { withProxy } from "../../../src/auth/oauth/http.ts";

test("TestRoundTripperForDirectBypassesProxy", () => {
  expect(withProxy({ method: "GET" }, "direct")).toEqual({ method: "GET" });
  expect(withProxy({ method: "GET" }, " DIRECT ")).toEqual({ method: "GET" });
  expect(withProxy({ method: "GET" }, "")).toEqual({ method: "GET" });
  expect(withProxy<RequestInit & { proxy?: string }>({ method: "GET" }, "http://proxy.example.com:8080").proxy).toBe("http://proxy.example.com:8080");
});
