import AsyncStorage from "@react-native-async-storage/async-storage";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { HostSyncService } from "./service";

let service: HostSyncService | null = null;

export function getHostSyncService(): HostSyncService {
  service ??= new HostSyncService(AsyncStorage, getHostRuntimeStore());
  return service;
}
