import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SettingsCard } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import { getHostSyncService } from "./runtime";
import { openSignInForm } from "./sign-in-form";
import type { HostSyncService } from "./service";

function SignInForm({
  service,
  endpoint,
}: {
  service: HostSyncService;
  endpoint: string;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const [form] = useState(() => openSignInForm(endpoint));
  const state = useSyncExternalStore(
    form.subscribe,
    form.getState,
    form.getState
  );
  useEffect(() => () => form.close(), [form]);
  const size = compact ? "md" : "sm";
  const editing = state.status !== "submitting";
  const setEndpoint = useCallback(
    (text: string) => form.set("endpoint", text),
    [form]
  );
  const setEmail = useCallback(
    (text: string) => form.set("email", text),
    [form]
  );
  const setPassword = useCallback(
    (text: string) => form.set("password", text),
    [form]
  );
  const submit = useCallback(() => {
    void form.submit((fields) => service.signIn(fields));
  }, [form, service]);
  return (
    <View style={styles.form}>
      <Field label={t("hostSync.endpoint")}>
        <FormTextInput
          testID="host-sync-endpoint"
          accessibilityLabel={t("hostSync.endpoint")}
          size={size}
          initialValue={endpoint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={editing}
          onChangeText={setEndpoint}
        />
      </Field>
      <Field label={t("hostSync.email")}>
        <FormTextInput
          testID="host-sync-email"
          accessibilityLabel={t("hostSync.email")}
          size={size}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          editable={editing}
          onChangeText={setEmail}
        />
      </Field>
      <Field
        label={t("hostSync.password")}
        error={state.status === "error" ? t("hostSync.signInError") : null}
      >
        <FormTextInput
          testID="host-sync-password"
          accessibilityLabel={t("hostSync.password")}
          size={size}
          secureTextEntry
          editable={editing}
          onChangeText={setPassword}
          onSubmitEditing={submit}
        />
      </Field>
      <Text style={settingsStyles.rowHint}>{t("hostSync.importNotice")}</Text>
      <Button
        testID="host-sync-sign-in"
        size={size}
        loading={!editing}
        disabled={!state.canSubmit}
        onPress={submit}
      >
        {t("hostSync.signIn")}
      </Button>
    </View>
  );
}

export function HostSyncSettingsSection() {
  const { t } = useTranslation();
  const service = getHostSyncService();
  const snapshot = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );
  const signOut = useMutation({ mutationFn: () => service.signOut() });
  const syncNow = useCallback(() => {
    void service.sync();
  }, [service]);
  const { mutate: logout } = signOut;
  const onSignOut = useCallback(() => logout(), [logout]);
  const loggedIn = snapshot.email !== null;
  const waiting = snapshot.status === "loading";
  return (
    <SettingsSection title={t("hostSync.title")}>
      <SettingsCard testID="host-sync-settings">
        <View style={styles.form}>
          <Text style={settingsStyles.rowTitle}>
            {t(`hostSync.status.${snapshot.status}`)}
          </Text>
          {loggedIn ? (
            <Text style={settingsStyles.rowHint}>
              {snapshot.email}
              {"\n"}
              {snapshot.endpoint}
            </Text>
          ) : null}
          {snapshot.pending > 0 ? (
            <Text style={settingsStyles.rowHint}>
              {t("hostSync.pending", { count: snapshot.pending })}
            </Text>
          ) : null}
          {snapshot.conflicts > 0 ? (
            <Text style={settingsStyles.rowHint}>
              {t("hostSync.conflicts", { count: snapshot.conflicts })}
            </Text>
          ) : null}
          {loggedIn ? (
            <Text style={settingsStyles.rowHint}>
              {t("hostSync.deleteNotice")}
            </Text>
          ) : null}
          {signOut.isError ? (
            <Text style={settingsStyles.rowError}>
              {t("hostSync.signOutError")}
            </Text>
          ) : null}
          {loggedIn ? (
            <View style={styles.actions}>
              <Button
                size="sm"
                variant="secondary"
                disabled={snapshot.status === "syncing" || signOut.isPending}
                loading={snapshot.status === "syncing"}
                onPress={syncNow}
              >
                {t("hostSync.syncNow")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                loading={signOut.isPending}
                disabled={signOut.isPending}
                onPress={onSignOut}
              >
                {t("hostSync.signOut")}
              </Button>
            </View>
          ) : null}
        </View>
        {!loggedIn && !waiting ? (
          <SignInForm
            key={snapshot.endpoint}
            endpoint={
              snapshot.endpoint ||
              process.env.EXPO_PUBLIC_HOST_SYNC_ENDPOINT ||
              ""
            }
            service={service}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: { padding: theme.spacing[4], gap: theme.spacing[3] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
}));
