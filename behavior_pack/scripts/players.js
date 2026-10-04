import { system, world } from "@minecraft/server";
import { loadingPlayers } from "./util.js";

// 한 번이라도 접속한 플레이어 기록 (나간 플레이어도 신고/밴 목록에 보이게)
// 값: [이름, 마지막 접속 시각, 나간 위치 { dimension, x, y, z, rx, ry }]
const PREFIX = "mlc:pl:";
const previousVisits = new Map(); // 이번 접속 직전 기록 (접속하자마자 덮어쓰기 전에 보관)

function read(id) {
  try {
    const raw = world.getDynamicProperty(PREFIX + id);
    if (typeof raw !== "string") return undefined;
    const [name, lastSeen, location] = JSON.parse(raw);
    return { name, lastSeen, location };
  } catch {
    return undefined;
  }
}

function write(id, name, lastSeen, location) {
  try {
    world.setDynamicProperty(PREFIX + id, JSON.stringify(location ? [name, lastSeen, location] : [name, lastSeen]));
  } catch {}
}

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn) return;
  const previous = read(player.id);
  previousVisits.set(player.id, previous);
  write(player.id, player.name, Date.now(), previous?.location);
});

world.beforeEvents.playerLeave.subscribe(({ player }) => {
  const id = player.id;
  const name = player.name;
  let location;
  // 접속 로딩 화면 중(하늘 위)에 나가면 위치를 덮어쓰지 않음
  if (!loadingPlayers.has(id)) {
    const { x, y, z } = player.location;
    const rotation = player.getRotation();
    location = { dimension: player.dimension.id, x, y, z, rx: rotation.x, ry: rotation.y };
  }
  system.run(() => write(id, name, Date.now(), location ?? read(id)?.location));
});

/** 이번 접속 직전 기록 (처음 온 플레이어면 undefined) */
export function getPreviousVisit(playerId) {
  return previousVisits.get(playerId);
}

/** 나간 플레이어의 마지막 위치 */
export function getLastLocation(playerId) {
  return read(playerId)?.location;
}

/** @returns {{ id: string, name: string, online: boolean, lastSeen: number, player?: import("@minecraft/server").Player }[]} 온라인 먼저, 그 다음 나간 플레이어(최근 순) */
export function getKnownPlayers() {
  const online = world.getAllPlayers().map((player) => ({ id: player.id, name: player.name, online: true, lastSeen: Date.now(), player }));
  const onlineIds = new Set(online.map((p) => p.id));
  const offline = [];
  for (const key of world.getDynamicPropertyIds()) {
    if (!key.startsWith(PREFIX)) continue;
    const id = key.slice(PREFIX.length);
    if (onlineIds.has(id)) continue;
    const record = read(id);
    if (record) offline.push({ id, name: record.name, online: false, lastSeen: record.lastSeen });
  }
  online.sort((a, b) => a.name.localeCompare(b.name));
  offline.sort((a, b) => b.lastSeen - a.lastSeen);
  return [...online, ...offline];
}

export function findOnlinePlayer(id) {
  return world.getAllPlayers().find((p) => p.id === id);
}
