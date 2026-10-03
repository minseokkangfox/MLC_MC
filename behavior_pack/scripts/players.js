import { system, world } from "@minecraft/server";

// 한 번이라도 접속한 플레이어 기록 (나간 플레이어도 신고/밴 목록에 보이게)
const PREFIX = "mlc:pl:";

function remember(player) {
  try {
    world.setDynamicProperty(PREFIX + player.id, JSON.stringify([player.name, Date.now()]));
  } catch {}
}

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (initialSpawn) remember(player);
});

world.beforeEvents.playerLeave.subscribe(({ player }) => {
  const id = player.id;
  const name = player.name;
  system.run(() => world.setDynamicProperty(PREFIX + id, JSON.stringify([name, Date.now()])));
});

/** @returns {{ id: string, name: string, online: boolean, lastSeen: number, player?: import("@minecraft/server").Player }[]} 온라인 먼저, 그 다음 나간 플레이어(최근 순) */
export function getKnownPlayers() {
  const online = world.getAllPlayers().map((player) => ({ id: player.id, name: player.name, online: true, lastSeen: Date.now(), player }));
  const onlineIds = new Set(online.map((p) => p.id));
  const offline = [];
  for (const key of world.getDynamicPropertyIds()) {
    if (!key.startsWith(PREFIX)) continue;
    const id = key.slice(PREFIX.length);
    if (onlineIds.has(id)) continue;
    try {
      const [name, lastSeen] = JSON.parse(String(world.getDynamicProperty(key)));
      offline.push({ id, name, online: false, lastSeen });
    } catch {}
  }
  online.sort((a, b) => a.name.localeCompare(b.name));
  offline.sort((a, b) => b.lastSeen - a.lastSeen);
  return [...online, ...offline];
}

export function findOnlinePlayer(id) {
  return world.getAllPlayers().find((p) => p.id === id);
}
