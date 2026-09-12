import { describe, expect, it } from "vitest";
import { openSignInForm } from "./sign-in-form";
import { normalizeSyncEndpoint } from "./service";

describe("host sync login form", () => {
  it("requires an HTTP service address and credentials", () => {
    const form = openSignInForm("");
    form.set("email", "user@example.test");
    form.set("password", "fixture-password");
    form.set("endpoint", "file:///tmp/data");
    expect(form.getState().canSubmit).toBe(false);
    form.set("endpoint", "https://sync.example.test/");
    expect(form.getState().canSubmit).toBe(true);
    expect(normalizeSyncEndpoint(form.getState().endpoint)).toBe("https://sync.example.test");
  });

  it("keeps failed input editable and clears the password after success", async () => {
    const form = openSignInForm("https://sync.example.test");
    form.set("email", "user@example.test");
    form.set("password", "fixture-password");
    await form.submit(async () => {
      throw new Error("Invalid account");
    });
    expect(form.getState().status).toBe("error");
    expect(form.getState().canSubmit).toBe(true);
    await form.submit(async () => undefined);
    expect(form.getState().status).toBe("editing");
    expect(form.getState().password).toBe("");
    expect(form.getState().canSubmit).toBe(false);
  });

  it("rejects addresses carrying embedded credentials", () => {
    expect(() => normalizeSyncEndpoint("https://user:password@sync.example.test")).toThrow();
    expect(() => normalizeSyncEndpoint("https://sync.example.test?token=secret")).toThrow();
  });
});
