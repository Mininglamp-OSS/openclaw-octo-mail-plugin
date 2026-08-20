import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";

import type { PluginAccountRuntimeRegistry } from "../accounts/account-runtime-registry.js";
import type { AgentMailAuthorizationService } from "../auth/agent-mail-authorization-service.js";
import { AgentMailRuntimeController } from "./agent-mail-runtime-controller.js";

describe("AgentMailRuntimeController", () => {
  it("starts once when concurrent tool calls arrive before Gateway service startup", async () => {
    let releaseStart: (() => void) | undefined;
    const start = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    );
    const stop = vi.fn();
    const service = {
      stop: vi.fn(async () => undefined),
    } as unknown as AgentMailAuthorizationService;
    const createAuthorizationService = vi.fn(() => service);
    const controller = createController({
      start,
      stop,
      createAuthorizationService,
    });

    const first = controller.ensureStarted();
    const second = controller.ensureStarted();
    expect(start).toHaveBeenCalledTimes(1);
    releaseStart?.();

    await expect(first).resolves.toBe(service);
    await expect(second).resolves.toBe(service);
    expect(createAuthorizationService).toHaveBeenCalledTimes(1);
  });

  it("reuses a lazily started runtime when the Gateway service starts later", async () => {
    const start = vi.fn(async () => undefined);
    const service = {
      stop: vi.fn(async () => undefined),
    } as unknown as AgentMailAuthorizationService;
    const controller = createController({
      start,
      stop: vi.fn(),
      createAuthorizationService: vi.fn(() => service),
    });

    await expect(controller.ensureStarted()).resolves.toBe(service);
    await expect(
      controller.ensureStarted({
        config: {} as OpenClawConfig,
        stateDir: "/gateway/state",
      }),
    ).resolves.toBe(service);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("cleans up failed startup and does not expose a partial service", async () => {
    const start = vi.fn(async () => {
      throw new Error("startup failed");
    });
    const stop = vi.fn();
    const createAuthorizationService = vi.fn(
      () =>
        ({ stop: vi.fn(async () => undefined) }) as unknown as AgentMailAuthorizationService,
    );
    const controller = createController({
      start,
      stop,
      createAuthorizationService,
    });

    await expect(controller.ensureStarted()).rejects.toThrow("startup failed");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(createAuthorizationService).not.toHaveBeenCalled();
  });

  it("cancels an in-progress startup when the Gateway service stops", async () => {
    let startSignal: AbortSignal | undefined;
    const start = vi.fn(
      async (context: { signal?: AbortSignal }) =>
        await new Promise<void>((_resolve, reject) => {
          startSignal = context.signal;
          context.signal?.addEventListener(
            "abort",
            () => reject(context.signal?.reason),
            { once: true },
          );
        }),
    );
    const stop = vi.fn();
    const createAuthorizationService = vi.fn(
      () =>
        ({ stop: vi.fn(async () => undefined) }) as unknown as AgentMailAuthorizationService,
    );
    const controller = createController({
      start,
      stop,
      createAuthorizationService,
    });

    const starting = controller.ensureStarted();
    const startRejected = expect(starting).rejects.toThrow(
      "Agent Mail runtime startup stopped",
    );

    await expect(controller.stop()).resolves.toBeUndefined();
    await startRejected;
    expect(startSignal?.aborted).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(createAuthorizationService).not.toHaveBeenCalled();
  });

  it("stops idempotently and can restart after a Gateway service reload", async () => {
    const stop = vi.fn();
    const logStopped = vi.fn();
    const start = vi.fn(async () => undefined);
    const createAuthorizationService = vi.fn(
      () =>
        ({ stop: vi.fn(async () => undefined) }) as unknown as AgentMailAuthorizationService,
    );
    const controller = createController({
      start,
      stop,
      createAuthorizationService,
      logStopped,
    });

    await controller.ensureStarted();
    await controller.stop();
    await controller.stop();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(logStopped).toHaveBeenCalledTimes(1);
    await expect(controller.ensureStarted()).resolves.toBeDefined();
    expect(start).toHaveBeenCalledTimes(2);
    expect(createAuthorizationService).toHaveBeenCalledTimes(2);
  });
});

function createController(input: {
  start: PluginAccountRuntimeRegistry["start"];
  stop: PluginAccountRuntimeRegistry["stop"];
  createAuthorizationService: (
    context: { config: OpenClawConfig; stateDir: string },
  ) => AgentMailAuthorizationService;
  logStopped?: () => void;
}): AgentMailRuntimeController {
  return new AgentMailRuntimeController({
    accountRuntimes: {
      start: input.start,
      stop: input.stop,
    } as unknown as Pick<PluginAccountRuntimeRegistry, "start" | "stop">,
    defaultContext: {
      config: {} as OpenClawConfig,
      stateDir: "/default/state",
    },
    createAuthorizationService: input.createAuthorizationService,
    logStarted: vi.fn(),
    logStopped: input.logStopped ?? vi.fn(),
  });
}
