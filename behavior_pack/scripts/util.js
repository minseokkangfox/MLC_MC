import { world } from "@minecraft/server";
import { CONFIG } from "./config.js";

const normalize = (name) => String(name).toLowerCase().replace(/\s+/g, "");
const ADMIN_NAMES = new Set(CONFIG.admins.map(normalize));

export const PREFIX = "§6[MLC]§r ";

/** 밴 kick 용으로 잠깐 놓은 커맨드 블록 위치 (커맨드 블록 제거 기능이 지우지 않도록) */
export const tempCommandBlocks = new Set();

export function isAdmin(player) {
  try {
    return ADMIN_NAMES.has(normalize(player.name));
  } catch {
    return false;
  }
}

export function notifyAdmins(message) {
  for (const player of world.getAllPlayers()) {
    if (isAdmin(player)) player.sendMessage(PREFIX + message);
  }
}

export function broadcast(message) {
  world.sendMessage(PREFIX + message);
}

export function utf8Length(text) {
  if (!text) return 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export function blockKey(dimensionId, location) {
  return `${dimensionId}|${Math.floor(location.x)}|${Math.floor(location.y)}|${Math.floor(location.z)}`;
}

export function formatLocation(location) {
  return `${Math.floor(location.x)}, ${Math.floor(location.y)}, ${Math.floor(location.z)}`;
}

export function shortDimension(dimensionId) {
  return dimensionId.replace("minecraft:", "");
}
