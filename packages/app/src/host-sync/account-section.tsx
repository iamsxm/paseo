import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SettingsCard } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { settingsStyles } from "@/styles/settings";
import { getHostSyncService } from "./runtime";

export function HostSyncAccountSection() {
  const { t } = useTranslation();
  const service = getHostSyncService();
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [busy, setBusy] = useState<"password" | "github" | "unlink" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { void service.refreshAccountLinks().catch(() => undefined); }, [service, snapshot.email]);
  const changePassword = useCallback(async () => {
    setBusy("password"); setMessage(null);
    try { await service.changePassword({ currentPassword, password, passwordConfirm }); setCurrentPassword(""); setPassword(""); setPasswordConfirm(""); setMessage(t("hostSync.account.passwordChanged")); }
    catch { setMessage(t("hostSync.account.passwordError")); } finally { setBusy(null); }
  }, [currentPassword, password, passwordConfirm, service, t]);
  const linkGitHub = useCallback(async () => { setBusy("github"); setMessage(null); try { await service.linkGitHub(); setMessage(t("hostSync.account.githubLinked")); } catch { setMessage(t("hostSync.account.githubError")); } finally { setBusy(null); } }, [service, t]);
  const unlinkGitHub = useCallback(async () => { setBusy("unlink"); setMessage(null); try { await service.unlinkGitHub(); setMessage(t("hostSync.account.githubUnlinked")); } catch { setMessage(t("hostSync.account.githubError")); } finally { setBusy(null); } }, [service, t]);
  if (!snapshot.email) return null;
  return <SettingsSection title={t("hostSync.account.title")}><SettingsCard testID="host-sync-account"><View style={{ padding: 16, gap: 12 }}>
    <Text style={settingsStyles.rowTitle}>{snapshot.email}</Text><Text style={settingsStyles.rowHint}>{t("hostSync.account.description")}</Text>
    <Button variant="secondary" disabled={busy !== null} loading={busy === "github"} onPress={linkGitHub}>{snapshot.githubLinked ? t("hostSync.account.githubLinkedLabel") : t("hostSync.account.linkGitHub")}</Button>
    {snapshot.githubLinked ? <Button variant="secondary" disabled={busy !== null} loading={busy === "unlink"} onPress={unlinkGitHub}>{t("hostSync.account.unlinkGitHub")}</Button> : null}
    <Field label={t("hostSync.account.currentPassword")}><FormTextInput secureTextEntry onChangeText={setCurrentPassword} /></Field>
    <Field label={t("hostSync.account.newPassword")}><FormTextInput secureTextEntry onChangeText={setPassword} /></Field>
    <Field label={t("hostSync.account.confirmPassword")}><FormTextInput secureTextEntry onChangeText={setPasswordConfirm} /></Field>
    <Button disabled={busy !== null || !currentPassword || !password || password !== passwordConfirm} loading={busy === "password"} onPress={changePassword}>{t("hostSync.account.changePassword")}</Button>
    {message ? <Text style={settingsStyles.rowHint}>{message}</Text> : null}
  </View></SettingsCard></SettingsSection>;
}
