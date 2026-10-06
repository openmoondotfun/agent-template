/**
 * Chat smoke test against a local fake Anthropic Messages API (no network).
 * An agent without a system_prompt.txt must still get answers: the handler
 * falls back to the built-in prompt instead of failing every message.
 */
import http from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const requests: any[] = [];
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(body || "{}"));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "test-model",
          content: [{ type: "text", text: "gm" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // chatHandler reads these when it is first imported, below.
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.AGENT_DIR = "__chat_test_no_agent__";
});

afterAll(() => {
  server?.close();
});

describe("handleChatMessage", () => {
  it("answers when the agent has no system_prompt.txt", async () => {
    const { handleChatMessage } = await import("./chatHandler");
    const reply = await handleChatMessage("conv-1", "Agent111", "hi", [{ role: "user", content: "hi" }], null);

    expect(JSON.parse(reply)).toEqual([{ type: "text", content: "gm" }]);
    expect(requests).toHaveLength(1);
    expect(typeof requests[0].system).toBe("string");
    expect(requests[0].system.length).toBeGreaterThan(0);
  });
});
