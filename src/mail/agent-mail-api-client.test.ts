import { describe, expect, it, vi } from "vitest";

import { AgentMailApiClient } from "./agent-mail-api-client.js";
import { MailClientError } from "./mail-client.js";
import { TEST_OCTO_ORIGIN } from "../testing/test-values.js";

const credential = "omb_test_prefix_secret";

describe("AgentMailApiClient", () => {
  it("reads the authoritative mailbox identity bound to the credential", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { address: "agent@example.test" }),
    );
    const client = createClient(fetchMock);

    await expect(client.getIdentityAddress()).resolves.toBe(
      "agent@example.test",
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${TEST_OCTO_ORIGIN}/agent-mail-api/webapi/v0/identity`,
    );
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization"),
    ).toBe(`Bearer ${credential}`);
  });

  it("classifies plain-text auth and rate-limit responses without exposing bodies", async () => {
    const unauthorized = createClient(
      vi.fn().mockResolvedValueOnce(new Response("unauthorized", { status: 401 })),
    );
    await expect(unauthorized.getIdentityAddress()).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });

    const rateLimited = createClient(
      vi.fn().mockResolvedValueOnce(
        new Response("too many authentication attempts", { status: 429 }),
      ),
    );
    await expect(rateLimited.getIdentityAddress()).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });


  it("reads the authenticated JMAP account and one rich email", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          capabilities: jmapCapabilities(),
          primaryAccounts: {
            "urn:ietf:params:jmap:mail": "42",
          },
          apiUrl: `${TEST_OCTO_ORIGIN}/agent-mail-api/jmap/api`,
          eventSourceUrl: `${TEST_OCTO_ORIGIN}/agent-mail-api/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          methodResponses: [
            [
              "Email/get",
              {
                accountId: "42",
                state: "9",
                list: [
                  {
                    id: "E7",
                    threadId: "T3",
                    mailboxIds: { inbox: true, sent: false },
                    receivedAt: "2026-08-03T08:00:00Z",
                    from: [{ name: "Alice", email: "alice@example.test" }],
                    to: [{ email: "agent@example.test" }],
                    cc: [],
                    subject: "Hello",
                    preview: "Plain body",
                    bodyStructure: {
                      type: "multipart/alternative",
                      subParts: [
                        { type: "text/plain", partId: "1.1" },
                        { type: "text/html", partId: "1.2" },
                      ],
                    },
                    bodyValues: {
                      "1.1": { value: "Plain body", isTruncated: false },
                      "1.2": { value: "<p>HTML body</p>", isTruncated: false },
                    },
                    hasAttachment: false,
                  },
                ],
                notFound: [],
              },
              "octo-mail-plugin",
            ],
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "E7",
          originalFrom: "bob@example.test",
          sentBy: "alice@example.test",
        }),
      );
    const client = createClient(fetchMock);

    await expect(client.getMessage("E7")).resolves.toMatchObject({
      emailId: "E7",
      threadId: "T3",
      mailboxIds: ["inbox"],
      subject: "Hello",
      textBody: "Plain body",
      htmlBody: "<p>HTML body</p>",
      originalFrom: "bob@example.test",
      sentBy: "alice@example.test",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${TEST_OCTO_ORIGIN}/agent-mail-api/.well-known/jmap`,
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `${TEST_OCTO_ORIGIN}/agent-mail-api/jmap/api`,
    );
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
      `${TEST_OCTO_ORIGIN}/agent-mail-api/webapi/v0/messages/E7`,
    );
    for (const call of fetchMock.mock.calls) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${credential}`);
    }
    const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      methodCalls: Array<[string, Record<string, unknown>, string]>;
    };
    expect(request.methodCalls[0]?.[0]).toBe("Email/get");
    expect(request.methodCalls[0]?.[1]).toEqual({
      accountId: "42",
      ids: ["E7"],
    });
  });

  it("keeps a normal JMAP message readable when forwarding detail is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jmapSession())
      .mockResolvedValueOnce(jmapMessageResponse())
      .mockResolvedValueOnce(
        jsonResponse(503, {
          error: { code: "unavailable", message: "try again later" },
        }),
      );

    await expect(createClient(fetchMock).getMessage("E7")).resolves.toMatchObject({
      emailId: "E7",
      subject: "Hello",
    });
  });

  it("keeps a normal JMAP message readable when forwarding detail loses transport", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jmapSession())
      .mockResolvedValueOnce(jmapMessageResponse())
      .mockRejectedValueOnce(new TypeError("socket closed"));

    await expect(createClient(fetchMock).getMessage("E7")).resolves.toMatchObject({
      emailId: "E7",
      subject: "Hello",
    });
  });

  it.each([
    [
      "invalid JSON",
      () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ],
    ["non-object JSON", () => jsonResponse(200, ["not", "an", "object"])],
    [
      "an oversized response",
      () =>
        new Response("x".repeat(8 * 1024 * 1024 + 1), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ],
  ])("keeps a normal JMAP message readable after %s", async (_name, detail) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jmapSession())
      .mockResolvedValueOnce(jmapMessageResponse())
      .mockResolvedValueOnce(detail());

    await expect(createClient(fetchMock).getMessage("E7")).resolves.toMatchObject({
      emailId: "E7",
      subject: "Hello",
    });
  });

  it("propagates caller cancellation during forwarding detail lookup", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jmapSession())
      .mockResolvedValueOnce(jmapMessageResponse())
      .mockImplementationOnce(
        (_target: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("request aborted")),
              { once: true },
            );
          }),
      );

    const pending = createClient(fetchMock).getMessage("E7", controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({
      code: "transport_failure",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    controller.abort();

    await rejection;
  });

  it("returns no forwarding attribution for a normal message detail", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jmapSession())
      .mockResolvedValueOnce(jmapMessageResponse())
      .mockResolvedValueOnce(jsonResponse(200, { id: "E7" }));

    const message = await createClient(fetchMock).getMessage("E7");

    expect(message).not.toHaveProperty("originalFrom");
    expect(message).not.toHaveProperty("sentBy");
  });

  it("returns no forwarding attribution when message detail has no id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jmapSession())
      .mockResolvedValueOnce(jmapMessageResponse())
      .mockResolvedValueOnce(jsonResponse(200, {}));

    const message = await createClient(fetchMock).getMessage("E7");

    expect(message).not.toHaveProperty("originalFrom");
    expect(message).not.toHaveProperty("sentBy");
  });

  it("rejects forwarding attribution for a different message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jmapSession())
      .mockResolvedValueOnce(jmapMessageResponse())
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "E8",
          originalFrom: "bob@example.test",
          sentBy: "alice@example.test",
        }),
      );

    await expect(createClient(fetchMock).getMessage("E7")).rejects.toMatchObject({
      code: "invalid_json_response",
      message: "Agent Mail returned forwarding attribution for a different message",
    });
  });

  it("fails closed for incomplete or malformed forwarding attribution", async () => {
    const incompleteFetch = vi
      .fn()
      .mockResolvedValueOnce(jmapSession())
      .mockResolvedValueOnce(jmapMessageResponse())
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "E7",
          originalFrom: "bob@example.test",
        }),
      );
    await expect(
      createClient(incompleteFetch).getMessage("E7"),
    ).rejects.toMatchObject({
      code: "invalid_json_response",
      message: "Agent Mail returned incomplete forwarding attribution",
    });

    const malformedFetch = vi
      .fn()
      .mockResolvedValueOnce(jmapSession())
      .mockResolvedValueOnce(jmapMessageResponse())
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "E7",
          originalFrom: "not a mailbox",
          sentBy: "alice@example.test",
        }),
      );
    await expect(
      createClient(malformedFetch).getMessage("E7"),
    ).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("fails closed for JMAP errors and missing email ids", async () => {
    const jmapErrorFetch = vi
      .fn()
      .mockResolvedValueOnce(jmapSession())
      .mockResolvedValueOnce(
        jsonResponse(200, {
          methodResponses: [
            ["error", { type: "forbidden", description: "read denied" }, "c1"],
          ],
        }),
      );
    const errorClient = createClient(jmapErrorFetch);
    await expect(errorClient.getMessage("E1")).rejects.toMatchObject({
      code: "forbidden",
      message: "read denied",
    });

    const missingFetch = vi
      .fn()
      .mockResolvedValueOnce(jmapSession())
      .mockResolvedValueOnce(
        jsonResponse(200, {
          methodResponses: [
            [
              "Email/get",
              { accountId: "42", state: "1", list: [], notFound: ["E404"] },
              "c1",
            ],
          ],
        }),
      );
    const missingClient = createClient(missingFetch);
    await expect(missingClient.getMessage("E404")).rejects.toMatchObject({
      code: "email_not_found",
    });
  });

  it("exposes standard Inbox, current state, and paged Email changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jmapSession())
      .mockResolvedValueOnce(
        jmapResponse("Mailbox/get", {
          accountId: "42",
          state: "10",
          list: [
            { id: "mb-inbox", name: "Inbox", role: "inbox" },
            { id: "mb-sent", name: "Sent", role: "sent" },
          ],
          notFound: [],
        }),
      )
      .mockResolvedValueOnce(
        jmapResponse("Email/get", {
          accountId: "42",
          state: "10",
          list: [],
          notFound: [],
        }),
      )
      .mockResolvedValueOnce(
        jmapResponse("Email/changes", {
          accountId: "42",
          oldState: "10",
          newState: "12",
          hasMoreChanges: true,
          created: ["E11"],
          updated: ["E9"],
          destroyed: [],
        }),
      );
    const client = createClient(fetchMock);

    await expect(client.getInboxMailboxId()).resolves.toBe("mb-inbox");
    await expect(client.getCurrentEmailState()).resolves.toBe("10");
    await expect(client.getEmailChanges("10", 100)).resolves.toEqual({
      oldState: "10",
      newState: "12",
      hasMoreChanges: true,
      created: ["E11"],
      updated: ["E9"],
      destroyed: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.slice(1).map(readJmapMethod)).toEqual([
      "Mailbox/get",
      "Email/get",
      "Email/changes",
    ]);
  });

  it("reads a server-verified automatic-reply context", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        enabled: true,
        autoReplyCount: 3,
        maxAutoReplyCount: 4,
        nextReplyIsFinal: true,
        limitReached: false,
      }),
    );

    await expect(
      createClient(fetchMock).getAutoReplyContext("E7"),
    ).resolves.toEqual({
      enabled: true,
      autoReplyCount: 3,
      maxAutoReplyCount: 4,
      nextReplyIsFinal: true,
      limitReached: false,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/messages/E7/auto-reply-context",
    );
  });

  it("fails closed when the JMAP Inbox role is absent or ambiguous", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jmapSession())
      .mockResolvedValueOnce(
        jmapResponse("Mailbox/get", {
          accountId: "42",
          state: "1",
          list: [],
          notFound: [],
        }),
      );
    await expect(createClient(fetchMock).getInboxMailboxId()).rejects.toMatchObject({
      code: "inbox_mailbox_ambiguous",
    });
  });

  it("prepares an unsent reply Draft without requesting a confirmation token", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(201, {
        outcome: "owner_confirmation_required",
        status: "pending_confirmation",
        draftType: "agent_reply_draft",
        draftId: "E8",
        draftVersion: 1,
        draftSubject: "Re: Question",
        senderAddress: "support@example.test",
        sourceEmailId: "E7",
        threadId: "T3",
      }),
    );
    const client = createClient(fetchMock);

    await expect(client.reply("E7", "Acknowledged.")).resolves.toEqual({
      outcome: "owner_confirmation_required",
      status: "pending_confirmation",
      draftType: "agent_reply_draft",
      draftId: "E8",
      draftVersion: 1,
      draftSubject: "Re: Question",
      senderAddress: "support@example.test",
      sourceEmailId: "E7",
      threadId: "T3",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const first = fetchMock.mock.calls[0]?.[1];
    expect(first?.body).toBe('{"text":"Acknowledged."}');
    expect(new Headers(first?.headers).get("X-Octo-Confirmation")).toBeNull();
  });

  it("submits one send intent and returns a manual-confirmation Draft", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(201, {
        outcome: "owner_confirmation_required",
        status: "pending_confirmation",
        draftType: "agent_pending_confirmation",
        draftId: "E9",
        draftVersion: 1,
        draftSubject: "Hello",
        senderAddress: "agent@example.test",
      }),
    );
    const client = createClient(fetchMock);

    await expect(
      client.send({
        to: ["recipient@example.test"],
        cc: ["copy@example.test"],
        subject: "Hello",
        text: "Exact body",
      }),
    ).resolves.toEqual({
      outcome: "owner_confirmation_required",
      status: "pending_confirmation",
      draftType: "agent_pending_confirmation",
      draftId: "E9",
      draftVersion: 1,
      draftSubject: "Hello",
      senderAddress: "agent@example.test",
    });

    const first = fetchMock.mock.calls[0]?.[1];
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/agent-mail-api/webapi/v0/agent-send-intents",
    );
    expect(first?.body).toBe(
      '{"to":["recipient@example.test"],"cc":["copy@example.test"],"subject":"Hello","text":"Exact body"}',
    );
    const firstIdempotency = new Headers(first?.headers).get(
      "X-Octo-Idempotency-Key",
    );
    expect(firstIdempotency).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns an accepted automatic send from the same send-intent endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(202, {
        outcome: "accepted",
        messageId: "E10",
        submissionIds: [19],
        senderAddress: "agent@mail.imocto.cn",
      }),
    );

    await expect(
      createClient(fetchMock).send({
        to: ["recipient@example.test"],
        subject: "Hello",
        text: "Automatic body",
      }),
    ).resolves.toEqual({
      outcome: "accepted",
      messageId: "E10",
      submissionIds: ["19"],
      senderAddress: "agent@mail.imocto.cn",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/agent-mail-api/webapi/v0/agent-send-intents",
    );
  });

  it("sends one exact versioned Draft through the owner-confirmed scope", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(202, {
        outcome: "accepted",
        messageId: "E11",
        submissionIds: [20],
        senderAddress: "agent@mail.imocto.cn",
      }),
    );

    await expect(
      createClient(fetchMock).sendPreparedDraft("E9", 2),
    ).resolves.toEqual({
      outcome: "accepted",
      messageId: "E11",
      submissionIds: ["20"],
      senderAddress: "agent@mail.imocto.cn",
    });

    const request = fetchMock.mock.calls[0]?.[1];
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/agent-mail-api/webapi/v0/drafts/E9/send",
    );
    expect(request?.body).toBe('{"draftVersion":2}');
    expect(new Headers(request?.headers).get("X-Octo-Automation")).toBe(
      "owner-confirmed-draft",
    );
    expect(
      new Headers(request?.headers).get("X-Octo-Idempotency-Key"),
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects an invalid prepared Draft version as an invalid argument", async () => {
    const fetchMock = vi.fn();

    await expect(
      createClient(fetchMock).sendPreparedDraft("E9", 0),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      outcome: "not-sent",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an unknown outcome when prepared Draft delivery loses transport", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("socket closed"));

    await expect(
      createClient(fetchMock).sendPreparedDraft("E9", 2),
    ).rejects.toMatchObject({
      code: "transport_failure",
      outcome: "unknown",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports an unknown outcome for a prepared Draft delivery server failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(503, {
        error: { code: "unavailable", message: "try again later" },
      }),
    );

    await expect(
      createClient(fetchMock).sendPreparedDraft("E9", 2),
    ).rejects.toMatchObject({
      code: "unavailable",
      status: 503,
      outcome: "unknown",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves an unknown write outcome for a non-JSON gateway failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("<html>bad gateway</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
    );

    await expect(
      createClient(fetchMock).sendPreparedDraft("E9", 2),
    ).rejects.toMatchObject({
      code: "http_error",
      status: 502,
      outcome: "unknown",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a non-JSON definite rejection classified as not sent", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("forbidden", { status: 403 }),
    );

    await expect(
      createClient(fetchMock).sendPreparedDraft("E9", 2),
    ).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
      outcome: "not-sent",
    });
  });

  it("returns owner-review metadata for a manual reply Draft intent", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(409, {
        error: {
          code: "outbound_review_required",
          message: "email was not sent; owner review is required",
        },
        policy: {
          outcome: "owner_review_required",
          status: "pending_confirmation",
          draftVersion: 1,
          policyVersion: "local-keyword-v1-test",
          reasons: [
            {
              code: "configured_review_term",
              title: "Owner review required",
              description: "Matched payment",
            },
          ],
          source: "inbound_auto_reply",
          sourceEmailId: "E7",
          draftId: "E42",
          draftSubject: "Payment plan",
        },
      }),
    );

    await expect(
      createClient(fetchMock).reply("E7", "Please review"),
    ).resolves.toMatchObject({
      outcome: "owner_review_required",
      draftId: "E42",
      sourceEmailId: "E7",
    });
  });

  it("returns owner review metadata for a scoped automatic reply", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(409, {
          error: {
            code: "outbound_review_required",
            message: "email was not sent; owner review is required",
          },
          policy: {
            outcome: "owner_review_required",
            status: "pending_confirmation",
            draftVersion: 1,
            policyVersion: "local-keyword-v1-test",
            reasons: [
              {
                code: "configured_review_term",
                title: "Owner review required",
                description: "Matched payment",
              },
            ],
            source: "inbound_auto_reply",
            sourceEmailId: "E7",
            draftId: "E42",
            draftSubject: "Payment plan",
          },
      }),
    );
    const client = createClient(fetchMock);

    await expect(
      client.replyAutomatically("E7", "Please review", undefined, "auto-42"),
    ).resolves.toMatchObject({
      outcome: "owner_review_required",
      status: "pending_confirmation",
      draftId: "E42",
      draftSubject: "Payment plan",
      source: "inbound_auto_reply",
    });
  });

  it("uses the scoped automation header without requesting a confirmation token", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(202, {
        messageId: "E10",
        submissionIds: [19],
        senderAddress: "agent@mail.imocto.cn",
      }),
    );
    const client = createClient(fetchMock);

    await expect(
      client.replyAutomatically("E7", "Thanks for your message."),
    ).resolves.toMatchObject({
      messageId: "E10",
      senderAddress: "agent@mail.imocto.cn",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("X-Octo-Automation")).toBe(
      "auto-reply",
    );
    expect(new Headers(request?.headers).get("X-Octo-Confirmation")).toBeNull();
  });

  it("returns a normal not-sent result when the automatic-reply chain reached its limit", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(409, {
        error: {
          code: "auto_reply_limit_reached",
          message: "automatic reply limit reached; no email was sent",
        },
      }),
    );

    await expect(
      createClient(fetchMock).replyAutomatically("E7", "One more reply"),
    ).resolves.toEqual({
      outcome: "auto_reply_stopped",
      reason: "max_auto_replies_reached",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the Session EventSource URL and emits Email StateChange notifications", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(
          new TextEncoder().encode(
            'id: 11\nevent: state\ndata: {"@type":"StateChange","changed":{"42":{"Email":"11"}}}\n\n',
          ),
        );
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jmapSession())
      .mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    const client = createClient(fetchMock);
    const onChange = vi.fn(async () => controller.abort());

    await client.watchEmailStateChanges(onChange, controller.signal);

    expect(onChange).toHaveBeenCalledWith({ accountId: "42", state: "11" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `${TEST_OCTO_ORIGIN}/agent-mail-api/jmap/eventsource?types=Email&closeafter=no&ping=30`,
    );
    const headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(headers.get("Accept")).toBe("text/event-stream");
    expect(headers.get("Authorization")).toBe(`Bearer ${credential}`);
  });

  it("rejects cross-origin JMAP resource URLs before sending the credential", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        capabilities: jmapCapabilities(),
        primaryAccounts: { "urn:ietf:params:jmap:mail": "42" },
        apiUrl: "https://attacker.example.test/jmap/api",
        eventSourceUrl: `${TEST_OCTO_ORIGIN}/agent-mail-api/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
      }),
    );
    const client = createClient(fetchMock);

    await expect(client.getMailAccountId()).rejects.toMatchObject({
      code: "untrusted_jmap_resource_url",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe API origins and non-Agent credentials", () => {
    expect(
      () =>
        new AgentMailApiClient({
          baseUrl: "https://user:pass@octo.example.test/path",
          credential,
        }),
    ).toThrow(/origin without credentials/);
    expect(
      () =>
        new AgentMailApiClient({
          baseUrl: TEST_OCTO_ORIGIN,
          credential: "omk_owner_key",
        }),
    ).toThrow(/omb_/);
  });
});

function createClient(fetchMock: ReturnType<typeof vi.fn>): AgentMailApiClient {
  return new AgentMailApiClient({
    baseUrl: TEST_OCTO_ORIGIN,
    credential,
    fetch: fetchMock as typeof fetch,
    timeoutMs: 1_000,
  });
}

function jmapSession(): Response {
  return jsonResponse(200, {
    capabilities: jmapCapabilities(),
    primaryAccounts: { "urn:ietf:params:jmap:mail": "42" },
    apiUrl: `${TEST_OCTO_ORIGIN}/agent-mail-api/jmap/api`,
    eventSourceUrl: `${TEST_OCTO_ORIGIN}/agent-mail-api/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
  });
}

function jmapCapabilities(): Record<string, Record<string, never>> {
  return {
    "urn:ietf:params:jmap:core": {},
    "urn:ietf:params:jmap:mail": {},
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jmapResponse(method: string, body: unknown): Response {
  return jsonResponse(200, {
    methodResponses: [[method, body, "octo-mail-plugin"]],
  });
}

function jmapMessageResponse(emailId = "E7"): Response {
  return jmapResponse("Email/get", {
    accountId: "42",
    state: "9",
    list: [
      {
        id: emailId,
        mailboxIds: { inbox: true },
        from: [{ name: "Alice", email: "alice@example.test" }],
        to: [{ email: "agent@example.test" }],
        cc: [],
        subject: "Hello",
        preview: "Plain body",
        hasAttachment: false,
      },
    ],
    notFound: [],
  });
}

function readJmapMethod(call: unknown[]): string | undefined {
  const init = call[1] as RequestInit | undefined;
  const request = JSON.parse(String(init?.body)) as {
    methodCalls?: Array<[string, unknown, string]>;
  };
  return request.methodCalls?.[0]?.[0];
}
