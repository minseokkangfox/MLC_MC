import { BlockPermutation, Direction, system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { clearBlockOwner, getBlockOwner, setBlockOwner } from "./ownership.js";
import { explosiveOwner } from "./tnt.js";
import { queueAdminNotice } from "./inbox.js";

// 모든 플레이어의 최근 행동(블럭 설치/파괴, TNT 폭발, 용암/물 붓기, 불 붙이기)을 기록하고,
// 테러로 밴하면 그 플레이어의 최근 5시간 행동을 전부 되돌립니다.
//
// 기록 형식: [시간(ms), 종류, 차원, x, y, z, ...추가]
//   p: 설치  [.., 설치한블럭]
//   b: 파괴  [.., 블럭, 상태, 원래주인]
//   x: 폭발  [.., 블럭, 상태, 원래주인]   (그 플레이어의 TNT로 부서진 블럭)
//   l: 액체  [.., 위치 두 곳 중 하나]
//   f: 불

const LOG_PREFIX = "mlc:act:";
const QUEUE_PREFIX = "mlc:rbq:";
const DIMS = { "minecraft:overworld": "o", "minecraft:nether": "n", "minecraft:the_end": "e" };
const DIM_IDS = { o: "minecraft:overworld", n: "minecraft:nether", e: "minecraft:the_end" };
const MAX_CHARS = 30000;
const FACE = {
  [Direction.Up]: [0, 1, 0],
  [Direction.Down]: [0, -1, 0],
  [Direction.North]: [0, 0, -1],
  [Direction.South]: [0, 0, 1],
  [Direction.East]: [1, 0, 0],
  [Direction.West]: [-1, 0, 0],
};
const windowMs = () => CONFIG.rollback.hours * 60 * 60 * 1000;

const buffers = new Map(); // 플레이어 id -> 아직 저장 안 한 기록

function record(playerId, op, dimensionId, location, ...extra) {
  if (!playerId) return;
  const entry = [
    Date.now(),
    op,
    DIMS[dimensionId] ?? "o",
    Math.floor(location.x),
    Math.floor(location.y),
    Math.floor(location.z),
    ...extra,
  ];
  let buffer = buffers.get(playerId);
  if (!buffer) buffers.set(playerId, (buffer = []));
  buffer.push(entry);
}

/** 기록 배열을 30KB 이하 묶음으로 나눔 */
function chunkEntries(entries) {
  const chunks = [];
  let current = [];
  let size = 2;
  for (const entry of entries) {
    const len = JSON.stringify(entry).length + 1;
    if (size + len > MAX_CHARS && current.length > 0) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(entry);
    size += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

let seq = 0;
function flushPlayer(playerId) {
  const buffer = buffers.get(playerId);
  if (!buffer || buffer.length === 0) return;
  buffers.delete(playerId);
  for (const chunk of chunkEntries(buffer)) {
    world.setDynamicProperty(`${LOG_PREFIX}${playerId}:${Date.now()}-${seq++}`, JSON.stringify(chunk));
  }
}

system.runInterval(() => {
  for (const playerId of [...buffers.keys()]) {
    try {
      flushPlayer(playerId);
    } catch {}
  }
}, 100);

// 5시간 지난 기록 삭제
system.runInterval(() => {
  const cutoff = Date.now() - windowMs() - 10 * 60 * 1000;
  for (const key of world.getDynamicPropertyIds()) {
    if (!key.startsWith(LOG_PREFIX)) continue;
    const time = Number(key.slice(key.lastIndexOf(":") + 1).split("-")[0]);
    if (time < cutoff) world.setDynamicProperty(key, undefined);
  }
}, 20 * 60 * 5);

// ---------- 기록 ----------

function permutationData(permutation) {
  return [permutation.type.id, permutation.getAllStates()];
}

world.afterEvents.playerPlaceBlock.subscribe(({ block, player, dimension }) => {
  setBlockOwner(dimension.id, block.location, player.id);
  record(player.id, "p", dimension.id, block.location, block.typeId);
});

world.afterEvents.playerBreakBlock.subscribe(({ block, brokenBlockPermutation, dimension, player }) => {
  const previousOwner = getBlockOwner(dimension.id, block.location) ?? 0;
  clearBlockOwner(dimension.id, block.location);
  record(player.id, "b", dimension.id, block.location, ...permutationData(brokenBlockPermutation), previousOwner);
});

world.afterEvents.blockExplode.subscribe(({ block, dimension, explodedBlockPermutation, source }) => {
  const previousOwner = getBlockOwner(dimension.id, block.location) ?? 0;
  clearBlockOwner(dimension.id, block.location);
  const owner = explosiveOwner(source);
  if (owner) record(owner, "x", dimension.id, block.location, ...permutationData(explodedBlockPermutation), previousOwner);
});

world.afterEvents.playerInteractWithBlock.subscribe(({ beforeItemStack, block, blockFace, player }) => {
  const item = beforeItemStack?.typeId;
  if (item !== "minecraft:lava_bucket" && item !== "minecraft:water_bucket" && item !== "minecraft:flint_and_steel" && item !== "minecraft:fire_charge") {
    return;
  }
  const [dx, dy, dz] = FACE[blockFace] ?? [0, 1, 0];
  const dimensionId = block.dimension.id;
  const front = { x: block.location.x + dx, y: block.location.y + dy, z: block.location.z + dz };
  if (item.endsWith("_bucket")) {
    record(player.id, "l", dimensionId, block.location);
    record(player.id, "l", dimensionId, front);
  } else {
    record(player.id, "f", dimensionId, front);
  }
});

// ---------- 되돌리기 ----------

const queueCache = new Map(); // 큐 키 -> 남은 기록
const dirtyQueues = new Set();
const cooldown = new Map(); // 큐 키 -> 다시 시도할 틱 (청크가 로딩 안 된 경우)
let queueKeys; // 남은 되돌리기 큐 키 목록 (정렬됨)

function getQueueKeys() {
  queueKeys ??= world.getDynamicPropertyIds().filter((k) => k.startsWith(QUEUE_PREFIX)).sort();
  return queueKeys;
}

/** 플레이어의 최근 5시간 행동 되돌리기 시작. 되돌릴 기록 개수 반환 */
export function startRollback(playerId, playerName) {
  flushPlayer(playerId);
  const since = Date.now() - windowMs();
  const prefix = `${LOG_PREFIX}${playerId}:`;
  const entries = [];
  for (const key of world.getDynamicPropertyIds()) {
    if (!key.startsWith(prefix)) continue;
    try {
      for (const entry of JSON.parse(String(world.getDynamicProperty(key)))) {
        if (entry[0] >= since) entries.push(entry);
      }
    } catch {}
    world.setDynamicProperty(key, undefined);
  }
  // 최근 행동부터 거꾸로 되돌림
  entries.sort((a, b) => b[0] - a[0]);
  chunkEntries(entries).forEach((chunk, i) => {
    const key = `${QUEUE_PREFIX}${Date.now()}-${String(i).padStart(5, "0")}`;
    world.setDynamicProperty(key, JSON.stringify(chunk));
    getQueueKeys().push(key);
  });
  if (entries.length > 0) queueAdminNotice(`${playerName} 의 최근 ${CONFIG.rollback.hours}시간 행동 ${entries.length}개 되돌리는 중`);
  return entries.length;
}

function restore(block, entry) {
  const [, , , , , , typeId, states, previousOwner] = entry;
  if (!block.isAir && !block.isLiquid && block.typeId !== "minecraft:fire") return;
  let permutation;
  try {
    permutation = BlockPermutation.resolve(typeId, states);
  } catch {
    permutation = BlockPermutation.resolve(typeId);
  }
  block.setPermutation(permutation);
  if (previousOwner) setBlockOwner(block.dimension.id, block.location, previousOwner);
}

/** @returns {boolean} 처리 완료 여부 (청크가 안 불러와져 있으면 false) */
function undo(entry) {
  const [, op, dim, x, y, z, typeId] = entry;
  const dimension = world.getDimension(DIM_IDS[dim]);
  let block;
  try {
    block = dimension.getBlock({ x, y, z });
  } catch {
    return false;
  }
  if (!block) return false;
  try {
    switch (op) {
      case "p":
        if (block.typeId === typeId) {
          block.setType("minecraft:air");
          clearBlockOwner(dimension.id, block.location);
        }
        break;
      case "b":
      case "x":
        restore(block, entry);
        break;
      case "l":
        if (block.typeId.includes("lava") || block.typeId.includes("water")) block.setType("minecraft:air");
        break;
      case "f":
        if (block.typeId === "minecraft:fire" || block.typeId === "minecraft:soul_fire") block.setType("minecraft:air");
        break;
    }
  } catch {}
  return true;
}

function loadQueue(key) {
  let entries = queueCache.get(key);
  if (!entries) {
    try {
      entries = JSON.parse(String(world.getDynamicProperty(key)));
    } catch {
      entries = [];
    }
    queueCache.set(key, entries);
  }
  return entries;
}

system.runInterval(() => {
  const now = system.currentTick;
  const keys = getQueueKeys();
  if (keys.length === 0) return;
  let budget = 150;
  for (const key of [...keys]) {
    if (budget <= 0) break;
    if ((cooldown.get(key) ?? 0) > now) continue;
    const entries = loadQueue(key);
    const remaining = [];
    let done = 0;
    for (const entry of entries) {
      if (budget <= 0 || !undo(entry)) {
        remaining.push(entry);
        continue;
      }
      budget--;
      done++;
    }
    if (remaining.length === 0) {
      queueCache.delete(key);
      dirtyQueues.delete(key);
      world.setDynamicProperty(key, undefined);
      keys.splice(keys.indexOf(key), 1);
    } else {
      queueCache.set(key, remaining);
      dirtyQueues.add(key);
      // 남은 건 전부 로딩 안 된 청크 -> 30초 뒤 재시도
      if (budget > 0 && done === 0) cooldown.set(key, now + 600);
    }
  }
}, 2);

// 진행 상황 저장 (게임이 꺼져도 이어서 되돌림)
system.runInterval(() => {
  for (const key of dirtyQueues) {
    const entries = queueCache.get(key);
    if (entries) world.setDynamicProperty(key, JSON.stringify(entries));
  }
  dirtyQueues.clear();
}, 100);
