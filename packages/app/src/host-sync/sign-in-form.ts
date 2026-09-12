import { normalizeSyncEndpoint } from "./service";

export interface SignInFields {
  endpoint: string;
  email: string;
  password: string;
}
interface SignInState extends SignInFields {
  status: "editing" | "submitting" | "error";
  canSubmit: boolean;
}

export function openSignInForm(endpoint: string) {
  let state: SignInState = {
    endpoint,
    email: "",
    password: "",
    status: "editing",
    canSubmit: false,
  };
  const listeners = new Set<() => void>();
  function publish(patch: Partial<SignInState>) {
    state = { ...state, ...patch };
    let validEndpoint = false;
    try {
      validEndpoint = Boolean(normalizeSyncEndpoint(state.endpoint));
    } catch {
      /* 输入过程中允许不完整地址。 */
    }
    state.canSubmit =
      validEndpoint &&
      state.email.trim().includes("@") &&
      state.password.length > 0 &&
      state.status !== "submitting";
    for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(field: keyof SignInFields, value: string) {
      publish({ [field]: value, status: "editing" });
    },
    async submit(signIn: (fields: SignInFields) => Promise<void>) {
      if (!state.canSubmit) return;
      const fields = { endpoint: state.endpoint, email: state.email, password: state.password };
      publish({ status: "submitting" });
      try {
        await signIn(fields);
        publish({ password: "", status: "editing" });
      } catch {
        publish({ status: "error" });
      }
    },
    close() {
      state = { ...state, password: "" };
      listeners.clear();
    },
  };
}
