import { BlockPermutation, BlockVolume, Direction, StructureSaveMode, system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { clearBlockOwner, getBlockOwner, setBlockOwner } from "./ownership.js";
import { explosiveOwner } from "./tnt.js";
import { queueAdminNotice } from "./inbox.js";
import { markWitherRemoval, witherOwner } from "./wither.js";

// 모든 플레이어의 최근 행동(블럭 설치/파괴, TNT 폭발, 용암/물 붓기, 불 붙이기)을 기록하고,
// 테러로 밴하면 그 플레이어의 최근 5시간 행동을 전부 되돌립니다.
//
// 기록 형식: [시간(ms), 종류, 차원, x, y, z, ...추가]
//   p: 설치  [.., 설치한블럭]
//   b: 파괴  [.., 블럭, 상태, 원래주인]
//   x: 폭발  [.., 블럭, 상태, 원래주인]   (그 플레이어의 TNT로 부서진 블럭)
//   c: 상자 등 컨테이너 파괴 [.., 구조물id(내용물 포함 저장), 원래주인]
//   s: 남의 상자를 열기 직전 내용물 [.., 구조물id, 블럭]  (훔쳐간 아이템 복구용)
//   l: 액체  [.., 위치 두 곳 중 하나]
//   w: 용암/물/불/TNT 직전 주변 지형 [.., 구조물id, 시작x, 시작y, 시작z]  (용암+물로 생긴 돌, 탄 블럭, 떨어진 모래 등 복구용)
//   m: 죽인 동물/주민 등 [.., 구조물id 또는 "", 몹 종류, 이름표]
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
      if (["c", "s", "w", "m"].includes(entry[1]) && entry[6]) world.structureManager.delete(entry[6]);
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

// 상자/통/화로 등 컨테이너와 표지판·액자·현수막·침대 같은 "데이터가 있는 블럭"은
// 부수기 직전에 통째로 구조물로 저장해 두었다가 되돌릴 때 그대로 복구 (내용물, 글씨, 액자 속 아이템, 색깔 등)
let structureSeq = 0;
const SPECIAL_BLOCK_WORDS = ["sign", "frame", "banner", "lectern", "jukebox", "chiseled_bookshelf", "decorated_pot", "flower_pot", "skull", "_head", "beehive", "bee_nest", "spawner", "campfire", "crafter", "note_block", "cauldron", "end_portal_frame"];
const isSpecialBlock = (typeId) => SPECIAL_BLOCK_WORDS.some((w) => typeId.includes(w));

world.beforeEvents.playerBreakBlock.subscribe((event) => {
  const { block, player } = event;
  if (event.cancel || block.typeId.endsWith("shulker_box")) return;
  let isContainer = false;
  try {
    isContainer = !!block.getComponent("minecraft:inventory") || isSpecialBlock(block.typeId);
  } catch {}
  if (!isContainer) return;
  event.cancel = true;
  const dimension = block.dimension;
  const location = { ...block.location };
  const playerId = player.id;
  system.run(() => breakContainer(dimension, location, playerId));
});

// 남의 상자/통 등을 열면, 열기 직전 내용물을 저장 (테러로 밴하면 훔쳐간 아이템까지 원래대로)
const snapshotTimes = new Map(); // "플레이어|위치" -> 마지막 저장 시각
world.afterEvents.playerInteractWithBlock.subscribe(({ block, player }) => {
  let isContainer = false;
  try {
    isContainer = !!block.getComponent("minecraft:inventory");
  } catch {}
  if (!isContainer) return;
  const dimension = block.dimension;
  const targets = [{ ...block.location }];
  // 큰 상자는 옆 칸도 같이
  for (const [dx, dy, dz] of HORIZONTAL) {
    const pos = { x: block.location.x + dx, y: block.location.y + dy, z: block.location.z + dz };
    try {
      if (dimension.getBlock(pos)?.typeId === block.typeId && block.typeId.includes("chest")) targets.push(pos);
    } catch {}
  }
  for (const location of targets) {
    if (getBlockOwner(dimension.id, location) === player.id) continue; // 자기 상자는 저장 안 함
    const key = `${player.id}|${dimension.id}|${location.x}|${location.y}|${location.z}`;
    const last = snapshotTimes.get(key);
    if (last !== undefined && Date.now() - last < windowMs()) continue; // 가장 처음 상태만 있으면 됨
    snapshotTimes.set(key, Date.now());
    const id = `mlc:rb${Date.now().toString(36)}${(structureSeq++).toString(36)}`;
    try {
      world.structureManager.createFromWorld(id, dimension, location, location, {
        includeEntities: false,
        saveMode: StructureSaveMode.World,
      });
      record(player.id, "s", dimension.id, location, id, dimension.getBlock(location)?.typeId ?? "");
    } catch {}
  }
});

// 용암/물을 붓기 직전 주변 지형을 저장해 두었다가, 되돌릴 때 용암·물 때문에 생긴 돌/조약돌/흑요석/현무암,
// 흐르는 물·용암, 불에 탄 자리를 저장한 모습으로 복구
const LIQUID_AREA = { horizontal: 10, below: 18, above: 10, reuse: 2 };
export const TNT_AREA = { horizontal: 7, below: 7, above: 10, reuse: 3 };
const areaSnapshots = new Map(); // 플레이어 id -> [{ dimensionId, x, y, z, time }]

/** 주변 지형을 구조물로 저장 (같은 사람이 1분 안에 바로 옆에서 저장했으면 생략) */
export function snapshotArea(playerId, dimension, center, area) {
  if (!playerId) return;
  center = { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) };
  const now = Date.now();
  const recent = (areaSnapshots.get(playerId) ?? []).filter((s) => now - s.time < 60 * 1000);
  const r = area.reuse;
  if (recent.some((s) => s.dimensionId === dimension.id && Math.abs(s.x - center.x) <= r && Math.abs(s.y - center.y) <= r && Math.abs(s.z - center.z) <= r)) {
    areaSnapshots.set(playerId, recent);
    return;
  }
  const { min, max } = dimension.heightRange;
  const from = { x: center.x - area.horizontal, y: Math.max(min, center.y - area.below), z: center.z - area.horizontal };
  const to = { x: center.x + area.horizontal, y: Math.min(max - 1, center.y + area.above), z: center.z + area.horizontal };
  const id = `mlc:rb${now.toString(36)}${(structureSeq++).toString(36)}`;
  try {
    world.structureManager.createFromWorld(id, dimension, from, to, { includeEntities: false, saveMode: StructureSaveMode.World });
    record(playerId, "w", dimension.id, center, id, from.x, from.y, from.z);
    recent.push({ dimensionId: dimension.id, ...center, time: now });
  } catch {}
  areaSnapshots.set(playerId, recent);
}

const LIQUID_DAMAGE = new Set([
  "minecraft:cobblestone",
  "minecraft:stone",
  "minecraft:obsidian",
  "minecraft:basalt",
  "minecraft:lava",
  "minecraft:flowing_lava",
  "minecraft:water",
  "minecraft:flowing_water",
  "minecraft:fire",
  "minecraft:soul_fire",
  "minecraft:air",
]);

const GRAVITY = new Set(["minecraft:sand", "minecraft:red_sand", "minecraft:gravel", "minecraft:suspicious_sand", "minecraft:suspicious_gravel"]);
const isGravity = (typeId) => GRAVITY.has(typeId) || typeId.endsWith("_concrete_powder");

/** @returns {boolean} 처리 완료 여부 */
function restoreArea(dimension, entry) {
  const [, , , , , , structureId, ox, oy, oz] = entry;
  const structure = world.structureManager.get(structureId);
  if (!structure) return true;
  const griefer = entry[entry.length - 1];
  const { x: sx, y: sy, z: sz } = structure.size;
  // 먼저 전부 로딩됐는지 확인
  if (!dimension.getBlock({ x: ox, y: oy, z: oz }) || !dimension.getBlock({ x: ox + sx - 1, y: oy + sy - 1, z: oz + sz - 1 })) return false;
  // 아래층부터 복구해야 모래/자갈이 받침 없이 떨어지지 않음
  for (let dy = 0; dy < sy; dy++) {
    for (let dx = 0; dx < sx; dx++) {
      for (let dz = 0; dz < sz; dz++) {
        const location = { x: ox + dx, y: oy + dy, z: oz + dz };
        const block = dimension.getBlock(location);
        if (!block || !(LIQUID_DAMAGE.has(block.typeId) || isGravity(block.typeId))) continue;
        const before = structure.getBlockPermutation({ x: dx, y: dy, z: dz });
        if (!before || before.type.id === block.typeId || before.type.id === "minecraft:tnt") continue; // TNT 는 다시 놓지 않음
        // 지금 그 자리에 다른 사람이 나중에 놓은 블럭이 있으면 건드리지 않음
        // (빈 칸/불/액체면 예전 주인 기록이 남아 있어도 탄 자리이므로 복구)
        if (!block.isAir && !block.isLiquid && !block.typeId.includes("fire")) {
          const owner = getBlockOwner(dimension.id, location);
          if (owner !== undefined && owner !== griefer) continue;
        }
        block.setPermutation(before);
      }
    }
  }
  world.structureManager.delete(structureId);
  return true;
}

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
  const owner = explosiveOwner(source) ?? witherOwner(source); // TNT 또는 그 사람이 소환한 위더의 폭발
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
  // 용암·물이 흐르고 불이 번지기 전 주변 지형 저장
  snapshotArea(player.id, block.dimension, front, LIQUID_AREA);
  // 불은 끝없이 번질 수 있어서, 번지는 불을 따라가며 그 앞쪽 지형을 계속 저장
  startFireWatch(player.id, block.dimension, front);
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

/** 플레이어별로 저장된 최근 행동 기록 개수 (밴 목록 표시용) */
export function countActions() {
  const since = Date.now() - windowMs();
  const counts = new Map();
  for (const key of world.getDynamicPropertyIds()) {
    if (!key.startsWith(LOG_PREFIX)) continue;
    const rest = key.slice(LOG_PREFIX.length);
    const playerId = rest.slice(0, rest.lastIndexOf(":"));
    try {
      let n = 0;
      for (const entry of JSON.parse(String(world.getDynamicProperty(key)))) if (entry[0] >= since) n++;
      counts.set(playerId, (counts.get(playerId) ?? 0) + n);
    } catch {}
  }
  for (const [playerId, buffer] of buffers) counts.set(playerId, (counts.get(playerId) ?? 0) + buffer.length);
  return counts;
}

/** 플레이어의 최근 행동 되돌리기 시작. 되돌릴 기록 개수 반환 */
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
  // 모래·자갈처럼 떨어지는 블럭 복구는 맨 마지막에, 아래층부터 (받침이 먼저 복구되도록)
  const isGravityRestore = (e) => (e[1] === "b" || e[1] === "x") && isGravity(e[6]);
  const falling = entries.filter(isGravityRestore).sort((a, b) => a[4] - b[4]);
  const others = entries.filter((e) => !isGravityRestore(e));
  entries.length = 0;
  entries.push(...others, ...falling);
  // 되돌릴 때 "다른 사람이 나중에 지은 블럭" 은 건드리지 않도록 누구의 기록인지 끝에 붙임
  for (const entry of entries) {
    if (entry[1] === "p") entry[7] = playerId;
    else entry.push(playerId);
  }
  chunkEntries(entries).forEach((chunk, i) => {
    const key = `${QUEUE_PREFIX}${Date.now()}-${String(i).padStart(5, "0")}`;
    world.setDynamicProperty(key, JSON.stringify(chunk));
    getQueueKeys().push(key);
  });
  markWitherRemoval(playerId); // 그 사람이 소환한 위더도 전부 제거
  if (entries.length > 0) queueAdminNotice(`${playerName} 의 최근 ${CONFIG.rollback.hours}시간 행동 ${entries.length}개 되돌리는 중`);
  return entries.length;
}

/** 복구해도 되는 자리인지: 다른 사람이 나중에 설치한 블럭만 아니면 덮어씀
 *  (그 사이 생긴 풀, 떨어진 모래/자갈, 흘러든 물, 용암으로 생긴 조약돌 등은 덮어씀) */
function canOverwrite(block, entry) {
  if (block.isAir || block.isLiquid) return true;
  const owner = getBlockOwner(block.dimension.id, block.location);
  return owner === undefined || owner === entry[entry.length - 1];
}

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

// ---------- 번지는 불 따라가기 ----------
// 8x8x8 칸 단위로 불이 있는지 계속 살펴보고, 불이 있는 칸의 주변 칸(26개)을 불이 닿기 전에 저장.
// 되돌릴 때 저장해 둔 모습으로 탄 자리를 복구하므로, 기지 전체가 타도 복구됨.
const CELL = 8;
const FIRE_TYPES = ["minecraft:fire", "minecraft:soul_fire"];
const MAX_CELLS = 4000;
const fireWatches = []; // { playerId, dimension, cells: Map(키 -> {x,y,z,last}), saved: Set(키), start }

const cellKey = (c) => `${c.x},${c.y},${c.z}`;

function saveCell(watch, c) {
  const key = cellKey(c);
  if (watch.saved.has(key) || watch.saved.size >= MAX_CELLS) return;
  const { min, max } = watch.dimension.heightRange;
  const from = { x: c.x * CELL, y: Math.max(min, c.y * CELL), z: c.z * CELL };
  const to = { x: c.x * CELL + CELL - 1, y: Math.min(max - 1, c.y * CELL + CELL - 1), z: c.z * CELL + CELL - 1 };
  if (from.y > to.y) {
    watch.saved.add(key);
    return;
  }
  const id = `mlc:rb${Date.now().toString(36)}${(structureSeq++).toString(36)}`;
  try {
    world.structureManager.createFromWorld(id, watch.dimension, from, to, { includeEntities: false, saveMode: StructureSaveMode.World });
    record(watch.playerId, "w", watch.dimension.id, from, id, from.x, from.y, from.z);
    watch.saved.add(key);
  } catch {
    // 아직 로딩 안 된 칸 - 나중에 다시
  }
}

/** 불이 있는(또는 생길) 칸 주변을 저장하고 감시 목록에 추가 */
function threaten(watch, c, now) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        saveCell(watch, n);
        const key = cellKey(n);
        if (!watch.cells.has(key) && watch.cells.size < MAX_CELLS) watch.cells.set(key, { ...n, last: now });
      }
    }
  }
}

/** 위더처럼 움직이며 부수는 것: 그 주변 칸들을 부서지기 전에 저장 (불 따라가기와 같은 방식) */
export function protectAround(playerId, dimension, location) {
  startFireWatch(playerId, dimension, location);
}

export function startFireWatch(playerId, dimension, location) {
  const now = system.currentTick;
  let watch = fireWatches.find((w) => w.playerId === playerId && w.dimension.id === dimension.id);
  if (!watch) {
    watch = { playerId, dimension, cells: new Map(), saved: new Set(), start: now };
    fireWatches.push(watch);
  }
  watch.start = now;
  threaten(watch, { x: Math.floor(location.x / CELL), y: Math.floor(location.y / CELL), z: Math.floor(location.z / CELL) }, now);
}

system.runInterval(() => {
  const now = system.currentTick;
  for (let i = fireWatches.length - 1; i >= 0; i--) {
    const watch = fireWatches[i];
    let budget = 60; // 한 번에 살펴볼 칸 수
    for (const [key, cell] of [...watch.cells]) {
      if (budget-- <= 0) break;
      watch.cells.delete(key);
      let burning = false;
      try {
        const volume = new BlockVolume({ x: cell.x * CELL, y: cell.y * CELL, z: cell.z * CELL }, { x: cell.x * CELL + CELL - 1, y: cell.y * CELL + CELL - 1, z: cell.z * CELL + CELL - 1 });
        burning = dimension_hasBlocks(watch.dimension, volume);
      } catch {}
      if (burning) {
        cell.last = now;
        threaten(watch, cell, now);
      }
      // 30초 동안 불이 없으면 그 칸은 그만 살펴봄 (맨 뒤로 보내서 돌아가며 검사)
      if (now - cell.last < 600) watch.cells.set(key, cell);
    }
    if (watch.cells.size === 0 || now - watch.start > 20 * 60 * 30) fireWatches.splice(i, 1);
  }
}, 10);

function dimension_hasBlocks(dimension, volume) {
  const list = dimension.getBlocks(volume, { includeTypes: FIRE_TYPES }, false);
  for (const _ of list.getBlockLocationIterator()) return true;
  return false;
}

// 구조물 배치가 같은 틱에 바로 끝나지 않을 수 있어서, 바로 지우면 블럭이 사라지는 문제가 생김 → 10초 뒤 삭제
function deleteStructureLater(structureId) {
  system.runTimeout(() => {
    try {
      world.structureManager.delete(structureId);
    } catch {}
  }, 200);
}

// ---------- 죽인 몹 (동물, 주민, 펫 등) ----------
// 플레이어가 처음 때린 순간 몹을 구조물로 저장해 두었다가, 그 사람이 죽이면 기록.
// 되돌릴 때 구조물로 다시 소환 (색깔·이름·길들인 주인·주민 거래 등 그대로). 한 방에 죽은 경우는 같은 종류로만 소환.
const mobSnapshots = new Map(); // 몹 id -> { structureId, playerId }

function isProtectedMob(entity) {
  if (entity.typeId === "minecraft:player" || entity.typeId === "minecraft:item" || entity.typeId === "minecraft:xp_orb") return false;
  try {
    const family = entity.getComponent("minecraft:type_family");
    if (family && family.hasTypeFamily("monster")) return false; // 몬스터 빼고 전부 (갑옷 거치대, 배, 마인카트 포함)
  } catch {}
  return !!entity.getComponent("minecraft:health");
}

function killerOf(damageSource) {
  const attacker = damageSource?.damagingEntity;
  if (!attacker) return undefined;
  if (attacker.typeId === "minecraft:player") return attacker.id;
  return explosiveOwner(attacker) ?? witherOwner(attacker); // TNT / 그 사람이 소환한 위더로 죽인 경우
}

world.afterEvents.entityHurt.subscribe(({ hurtEntity, damageSource }) => {
  const playerId = killerOf(damageSource);
  if (!playerId || mobSnapshots.has(hurtEntity.id)) return;
  try {
    if (!isProtectedMob(hurtEntity)) return;
    const health = hurtEntity.getComponent("minecraft:health");
    if (!health || health.currentValue <= 0) return; // 이미 죽음 (한 방) → 죽을 때 종류만 기록
    const location = { x: Math.floor(hurtEntity.location.x), y: Math.floor(hurtEntity.location.y), z: Math.floor(hurtEntity.location.z) };
    const id = `mlc:rb${Date.now().toString(36)}${(structureSeq++).toString(36)}`;
    world.structureManager.createFromWorld(id, hurtEntity.dimension, location, location, {
      includeBlocks: false,
      includeEntities: true,
      saveMode: StructureSaveMode.World,
    });
    const entityId = hurtEntity.id;
    mobSnapshots.set(entityId, { structureId: id, playerId });
    // 5분 안에 안 죽으면 저장한 것 삭제
    system.runTimeout(() => {
      const snap = mobSnapshots.get(entityId);
      if (snap && snap.structureId === id) {
        mobSnapshots.delete(entityId);
        try {
          world.structureManager.delete(id);
        } catch {}
      }
    }, 20 * 60 * 5);
  } catch {}
});

world.afterEvents.entityDie.subscribe(({ deadEntity, damageSource }) => {
  const snap = mobSnapshots.get(deadEntity.id);
  mobSnapshots.delete(deadEntity.id);
  const playerId = killerOf(damageSource) ?? snap?.playerId;
  if (!playerId) {
    if (snap) world.structureManager.delete(snap.structureId);
    return;
  }
  try {
    if (!snap && !isProtectedMob(deadEntity)) return;
    const location = deadEntity.location;
    let nameTag = "";
    try {
      nameTag = deadEntity.nameTag ?? "";
    } catch {}
    record(playerId, "m", deadEntity.dimension.id, location, snap?.structureId ?? "", deadEntity.typeId, nameTag);
  } catch {}
});

/** @returns {boolean} 처리 완료 여부 */
function restoreMob(dimension, entry) {
  const [, , , x, y, z, structureId, typeId, nameTag] = entry;
  if (!dimension.getBlock({ x, y, z })) return false; // 청크 로딩 대기
  if (structureId && world.structureManager.get(structureId)) {
    world.structureManager.place(structureId, dimension, { x, y, z }, { includeBlocks: false, includeEntities: true });
    deleteStructureLater(structureId);
    return true;
  }
  const mob = dimension.spawnEntity(typeId, { x: x + 0.5, y, z: z + 0.5 });
  if (nameTag) mob.nameTag = nameTag;
  return true;
}

function restore(block, entry) {
  const [, , , , , , typeId, states, previousOwner] = entry;
  if (!canOverwrite(block, entry)) return;
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
        if (canOverwrite(block, entry)) {
          try {
            world.structureManager.place(structureId, dimension, { x, y, z }, { includeEntities: false });
          } catch {
            return false;
          }
          if (previousOwner) setBlockOwner(dimension.id, block.location, previousOwner);
        }
        deleteStructureLater(structureId);
        break;
      }
      case "s": {
        const [, , , , , , structureId, containerType] = entry;
        if (block.typeId === containerType || canOverwrite(block, entry)) {
          try {
            world.structureManager.place(structureId, dimension, { x, y, z }, { includeEntities: false });
          } catch {
            return false;
          }
        }
        deleteStructureLater(structureId);
        break;
      }
      case "m":
        return restoreMob(dimension, entry);
      case "w":
        try {
          return restoreArea(dimension, entry);
        } catch {
          return false;
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
