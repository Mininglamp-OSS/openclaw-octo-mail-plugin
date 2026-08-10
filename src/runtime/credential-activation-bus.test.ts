import { describe, expect, it, vi } from "vitest";

import {
  notifyCredentialActivation,
  subscribeCredentialActivation,
} from "./credential-activation-bus.js";

describe("credential activation bus", () => {
  it("broadcasts only the non-secret Plugin Account id and supports unsubscribe", async () => {
    const listener = vi.fn(async () => undefined);
    const unsubscribe = subscribeCredentialActivation(listener);

    await notifyCredentialActivation("support");
    expect(listener).toHaveBeenCalledWith("support");

    unsubscribe();
    await notifyCredentialActivation("sales");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
