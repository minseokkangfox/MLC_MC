import { BlockPermutation, BlockVolume, Direction, StructureSaveMode, system, world } from "@minecraft/server";
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
//   c: 상자 등 컨테이너 파괴 [.., 구조물id(내용물 포함 저장), 원래주인]
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
    if (time < cutoff) {
      deleteStructures(world.getDynamicProperty(key));
      world.setDynamicProperty(key, undefined);
    }
  }
}, 20 * 60 * 5);

function deleteStructures(raw) {
  try {
    for (const entry of JSON.parse(String(raw))) {
      if (entry[1] === "c") world.structureManager.delete(entry[6]);
    }
  } catch {}
}

// ---------- 기록 ----------

function permutationData(permutation) {
  return [permutation.type.id, permutation.getAllStates()];
}

world.afterEvents.playerPlaceBlock.subscribe(({ block, player, dimension }) => {
  const location = { ...block.location };
  setBlockOwner(dimension.id, location, player.id);
  record(player.id, "p", dimension.id, location, block.typeId);
  // 문/침대 같은 두 칸짜리 블럭은 나머지 한 칸도 주인 기록
  system.run(() => {
    for (const other of otherHalves(dimension, location)) {
      setBlockOwner(dimension.id, other, player.id);
      record(player.id, "p", dimension.id, other, dimension.getBlock(other)?.typeId ?? "");
    }
  });
});

const HORIZONTAL = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const VERTICAL = [
  [0, 1, 0],
  [0, -1, 0],
];

function isTwoBlockType(typeId) {
  return (typeId.includes("door") && !typeId.includes("trapdoor")) || typeId === "minecraft:bed" || typeId.includes("double_plant") ||
    ["minecraft:tall_grass", "minecraft:large_fern", "minecraft:sunflower", "minecraft:lilac", "minecraft:rose_bush", "minecraft:peony",
      "minecraft:pitcher_plant", "minecraft:small_dripleaf_block"].includes(typeId);
}

function otherHalves(dimension, location) {
  const result = [];
  try {
    const typeId = dimension.getBlock(location)?.typeId;
    if (!typeId || !isTwoBlockType(typeId)) return result;
    const offsets = typeId === "minecraft:bed" ? HORIZONTAL : VERTICAL;
    for (const [dx, dy, dz] of offsets) {
      const pos = { x: location.x + dx, y: location.y + dy, z: location.z + dz };
      if (dimension.getBlock(pos)?.typeId === typeId && getBlockOwner(dimension.id, pos) === undefined) {
        result.push(pos);
        if (typeId === "minecraft:bed") break;
      }
    }
  } catch {}
  return result;
}

// 상자/통/화로 등 컨테이너는 부수기 직전에 내용물째 구조물로 저장해 두었다가 되돌릴 때 그대로 복구
let structureSeq = 0;
world.beforeEvents.playerBreakBlock.subscribe((event) => {
  const { block, player } = event;
  if (event.cancel || block.typeId.endsWith("shulker_box")) return;
  let isContainer = false;
  try {
    isContainer = !!block.getComponent("minecraft:inventory");
  } catch {}
  if (!isContainer) return;
  event.cancel = true;
  const dimension = block.dimension;
  const location = { ...block.location };
  const playerId = player.id;
  system.run(() => breakContainer(dimension, location, playerId));
});

function breakContainer(dimension, location, playerId) {
  const block = dimension.getBlock(location);
  if (!block || block.isAir) return;
  const permutation = block.permutation;
  const id = `mlc:rb${Date.now().toString(36)}${(structureSeq++).toString(36)}`;
  let saved = false;
  try {
    world.structureManager.createFromWorld(id, dimension, location, location, {
      includeEntities: false,
      saveMode: StructureSaveMode.World,
    });
    saved = true;
  } catch {}
  const previousOwner = getBlockOwner(dimension.id, location) ?? 0;
  clearBlockOwner(dimension.id, location);
  try {
    dimension.runCommand(`setblock ${location.x} ${location.y} ${location.z} air destroy`);
  } catch {
    block.setType("minecraft:air");
  }
  if (saved) record(playerId, "c", dimension.id, location, id, previousOwner);
  else record(playerId, "b", dimension.id, location, ...permutationData(permutation), previousOwner);
}

world.afterEvents.playerBreakBlock.subscribe(({ block, brokenBlockPermutation, dimension, player }) => {
  const previousOwner = getBlockOwner(dimension.id, block.location) ?? 0;
  clearBlockOwner(dimension.id, block.location);
  record(player.id, "b", dimension.id, block.location, ...permutationData(brokenBlockPermutation), previousOwner);
});

world.afterEvents.blockExplode.subscribe(({ block, dimension, explodedBlockPermutation, source }) => {
  // 폭발에 맞은 TNT는 연쇄로 터짐: 주인 기록을 남겨둬야 그 TNT도 같은 사람 것으로 기록됨 (tnt.js 에서 정리)
  // 또 되돌릴 때 TNT를 다시 놓으면 안 되므로 기록하지 않음
  if (explodedBlockPermutation.type.id === "minecraft:tnt") return;
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
  for (const entry of entries) if (entry[1] === "p") entry[7] = playerId;
  chunkEntries(entries).forEach((chunk, i) => {
    const key = `${QUEUE_PREFIX}${Date.now()}-${String(i).padStart(5, "0")}`;
    world.setDynamicProperty(key, JSON.stringify(chunk));
    getQueueKeys().push(key);
  });
  if (entries.length > 0) queueAdminNotice(`${playerName} 의 최근 ${CONFIG.rollback.hours}시간 행동 ${entries.length}개 되돌리는 중`);
  return entries.length;
}

const isReplaceable = (block) =>
  block.isAir || block.isLiquid || block.typeId === "minecraft:fire" || block.typeId === "minecraft:soul_fire" ||
  block.typeId === "minecraft:cobblestone" || block.typeId === "minecraft:obsidian";

const FLOWING = ["minecraft:flowing_lava", "minecraft:flowing_water"];
const LAVA_LEFTOVERS = ["minecraft:cobblestone", "minecraft:obsidian"];

/** 부은 용암/물이 흘러간 자리와 그 때문에 생긴 조약돌/흑요석 정리 */
function clearLiquidArea(dimension, center) {
  const volume = new BlockVolume(
    { x: center.x - 8, y: center.y - 24, z: center.z - 8 },
    { x: center.x + 8, y: center.y + 1, z: center.z + 8 }
  );
  // 누가 설치한 블럭은 건드리지 않고, 기록 없는 조약돌/흑요석 중 액체에 닿아 있는 것만 (용암+물로 생긴 것)
  const leftovers = [];
  for (const location of dimension.getBlocks(volume, { includeTypes: LAVA_LEFTOVERS }, false).getBlockLocationIterator()) {
    if (getBlockOwner(dimension.id, location) === undefined && touchesLiquid(dimension, location)) leftovers.push(location);
  }
  for (const location of dimension.getBlocks(volume, { includeTypes: FLOWING }, false).getBlockLocationIterator()) {
    dimension.getBlock(location)?.setType("minecraft:air");
  }
  for (const location of leftovers) dimension.getBlock(location)?.setType("minecraft:air");
}

function touchesLiquid(dimension, location) {
  for (const [dx, dy, dz] of [...HORIZONTAL, ...VERTICAL]) {
    const b = dimension.getBlock({ x: location.x + dx, y: location.y + dy, z: location.z + dz });
    if (b && b.isLiquid) return true;
  }
  return false;
}

function restore(block, entry) {
  const [, , , , , , typeId, states, previousOwner] = entry;
  if (!isReplaceable(block)) return;
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
      case "p": {
        // 같은 블럭이거나(불 켜진 화로처럼 모양이 바뀐 것 포함) 아직 그 사람 소유로 기록된 블럭이면 제거
        const ownedByThem = entry[7] !== undefined && getBlockOwner(dimension.id, block.location) === entry[7];
        if (!block.isAir && (block.typeId === typeId || ownedByThem)) {
          block.setType("minecraft:air");
          clearBlockOwner(dimension.id, block.location);
        }
        break;
      }
      case "c": {
        const [, , , , , , structureId, previousOwner] = entry;
        if (isReplaceable(block)) {
          try {
            world.structureManager.place(structureId, dimension, { x, y, z }, { includeEntities: false });
          } catch {
            return false;
          }
          if (previousOwner) setBlockOwner(dimension.id, block.location, previousOwner);
        }
        world.structureManager.delete(structureId);
        break;
      }
      case "b":
      case "x":
        restore(block, entry);
        break;
      case "l":
        try {
          clearLiquidArea(dimension, { x, y, z });
        } catch {
          return false; // 주변 청크가 아직 로딩 안 됨
        }
        if (block.typeId.includes("lava") || block.typeId.includes("water")) block.setType("minecraft:air");
        else if (block.isWaterlogged) block.setWaterlogged(false);
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
