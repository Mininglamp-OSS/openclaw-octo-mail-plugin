import { MailClientError, type MailEmailStateChange } from "./mail-client.js";

const REQUIRED_EVENT_SOURCE_VARIABLES = ["types", "closeafter", "ping"] as const;

export function expandJmapEventSourceUrl(
  template: string,
  values: { types: string; closeafter: "state" | "no"; ping: number },
): string {
  let expanded = template;
  for (const name of REQUIRED_EVENT_SOURCE_VARIABLES) {
    const marker = `{${name}}`;
    if (!expanded.includes(marker)) {
      throw new MailClientError({
        code: "invalid_jmap_session",
        message: `JMAP eventSourceUrl is missing ${marker}`,
      });
    }
    expanded = expanded.replaceAll(
      marker,
      encodeURIComponent(String(values[name])),
    );
  }
  return expanded;
}

export async function consumeJmapEventSource(
  body: ReadableStream<Uint8Array>,
  accountId: string,
  onChange: (change: MailEmailStateChange) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const dispatch = async () => {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }
    const data = dataLines.join("\n");
    dataLines = [];
    const currentEvent = eventName;
    eventName = "message";
    if (currentEvent !== "state") {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch (cause) {
      throw new MailClientError({
        code: "invalid_jmap_event_source",
        message: "JMAP EventSource returned invalid JSON",
        cause,
      });
    }
    if (!isRecord(value) || value["@type"] !== "StateChange") {
      throw new MailClientError({
        code: "invalid_jmap_event_source",
        message: "JMAP EventSource returned an invalid StateChange",
      });
    }
    const changed = value["changed"];
    const accountChanges = isRecord(changed) ? changed[accountId] : undefined;
    const emailState = isRecord(accountChanges)
      ? accountChanges["Email"]
      : undefined;
    if (typeof emailState === "string" && emailState.length > 0) {
      await onChange({ accountId, state: emailState });
    }
  };

  try {
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }
        if (line === "") {
          await dispatch();
          continue;
        }
        if (line.startsWith(":")) {
          continue;
        }
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let fieldValue = colon < 0 ? "" : line.slice(colon + 1);
        if (fieldValue.startsWith(" ")) {
          fieldValue = fieldValue.slice(1);
        }
        if (field === "event") {
          eventName = fieldValue;
        } else if (field === "data") {
          dataLines.push(fieldValue);
        }
      }
    }
    if (buffer.length > 0) {
      dataLines.push(buffer);
    }
    await dispatch();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
