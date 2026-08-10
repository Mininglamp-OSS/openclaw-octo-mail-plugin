import { describe, expect, it, vi } from "vitest";

import {
  consumeJmapEventSource,
  expandJmapEventSourceUrl,
} from "./jmap-event-source.js";

describe("JMAP EventSource", () => {
  it("expands all RFC 8620 EventSource URI-template variables", () => {
    expect(
      expandJmapEventSourceUrl(
        "https://octo.example.test/events?types={types}&closeafter={closeafter}&ping={ping}",
        { types: "Email", closeafter: "no", ping: 30 },
      ),
    ).toBe(
      "https://octo.example.test/events?types=Email&closeafter=no&ping=30",
    );
    expect(() =>
      expandJmapEventSourceUrl("https://octo.example.test/events", {
        types: "Email",
        closeafter: "no",
        ping: 30,
      }),
    ).toThrow(/missing \{types\}/);
  });

  it("parses chunked state events and ignores ping and other accounts", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      "event: ping\ndata: {\"interval\":30}\n\n",
      "event: state\ndata: {\"@type\":\"StateChange\",\"changed\":{",
      "\"other\":{\"Email\":\"4\"},\"42\":{\"Email\":\"9\"}}}\n\n",
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    const onChange = vi.fn(async () => undefined);

    await consumeJmapEventSource(
      stream,
      "42",
      onChange,
      new AbortController().signal,
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ accountId: "42", state: "9" });
  });
});
