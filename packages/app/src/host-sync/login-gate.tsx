import { type ReactNode, useSyncExternalStore } from "react";
import { ScrollView, View } from "react-native";
import { getHostSyncService } from "./runtime";
import { HostSyncSettingsSection } from "./settings-section";

// 自建发行版要求同步账号登录；后台仍负责逐请求验证权限。
export function HostSyncLoginGate({ children }: { children: ReactNode }) {
  const service = getHostSyncService();
  const snapshot = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );
  if (process.env.EXPO_PUBLIC_HOST_SYNC_REQUIRED !== "true") return children;
  const authenticated =
    snapshot.email !== null &&
    snapshot.lastSyncedAt !== null &&
    snapshot.status !== "expired" &&
    snapshot.status !== "signedOut";
  if (authenticated) return children;
  return (
    <ScrollView
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: "center",
        padding: 24,
      }}
    >
      <View style={{ width: "100%", maxWidth: 520, alignSelf: "center" }}>
        <HostSyncSettingsSection />
      </View>
    </ScrollView>
  );
}
