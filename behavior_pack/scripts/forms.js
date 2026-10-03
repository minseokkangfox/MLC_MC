import { system } from "@minecraft/server";
import { FormCancelationReason } from "@minecraft/server-ui";

const sleep = (ticks) => new Promise((resolve) => system.runTimeout(() => resolve(undefined), ticks));

/** 채팅창이 닫힐 때까지 기다렸다가 폼을 띄움 */
export async function showForm(player, form) {
  for (let i = 0; i < 60; i++) {
    if (!player.isValid) return undefined;
    const response = await form.show(player);
    if (response.canceled && response.cancelationReason === FormCancelationReason.UserBusy) {
      await sleep(5);
      continue;
    }
    return response;
  }
  return undefined;
}

export const PLAYER_ICON = "textures/ui/icon_steve";

/** 한국 시간(KST)으로 표시 */
export function formatTime(ms) {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function timeAgo(ms) {
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

export function playerButtonText(entry) {
  return entry.online ? `§2● §0${entry.name}\n§2접속 중` : `§8○ §0${entry.name}\n§8나감 · ${timeAgo(entry.lastSeen)}`;
}
