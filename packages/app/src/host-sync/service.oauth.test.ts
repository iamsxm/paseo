import { beforeEach, describe, expect, it, vi } from "vitest";

const authWithOAuth2 = vi.fn();
const send = vi.fn();

vi.mock("pocketbase", () => ({
  default: class FakePocketBase {
    authStore = { isValid: true, token: "oauth-token" };
    collection() {
      return { authWithOAuth2 };
    }
    send = send;
    cancelAllRequests() {}
  },
  BaseAuthStore: class FakeAuthStore {
    save() {}
  },
  ClientResponseError: class ClientResponseError extends Error {},
  isTokenExpired: () => false,
}));

import { HostSyncService } from "./service";

describe("HostSyncService GitHub OAuth", () => {
  beforeEach(() => {
    authWithOAuth2.mockReset();
    send.mockReset();
    authWithOAuth2.mockResolvedValue({
      token: "oauth-token",
      record: {
        id: "github-user",
        email: "user@example.test",
        collectionId: "sync-users",
        collectionName: "sync_users",
      },
    });
    send.mockResolvedValue({ records: [], conflicts: [] });
  });

  it("opens GitHub OAuth synchronously and persists the resulting account", async () => {
    const values = new Map<string, string>();
    const service = new HostSyncService(
      {
        getItem: async (key) => values.get(key) ?? null,
        setItem: async (key, value) => void values.set(key, value),
      },
      {
        boot: async () => undefined,
        getHosts: () => [],
        subscribeHostList: () => () => undefined,
        applySyncedRelayHosts: async () => undefined,
      }
    );
    await service.start();

    const authentication = service.signInWithGitHub(
      "https://sync.example.test"
    );
    expect(authWithOAuth2).toHaveBeenCalledWith({ provider: "github" });
    await authentication;

    expect(service.getSnapshot().email).toBe("user@example.test");
    expect(values.get("@paseo:host-sync:v1")).toContain("oauth-token");
    service.stop();
  });
});
