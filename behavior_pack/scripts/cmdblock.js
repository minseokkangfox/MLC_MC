import { BlockVolume, system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { blockKey, formatLocation, shortDimension, tempCommandBlocks } from "./util.js";
import { queueAdminNotice } from "./inbox.js";
import { isForceSurvival } from "./gamemode.js";

// 게임모드를 바꾸는 명령어는 스크립트로 내용을 읽을 수 없어서,
// 강제 서바이벌 모드가 켜져 있는 동안 로딩된 청크의 커맨드 블록을 전부 찾아 제거합니다.
const COMMAND_BLOCKS = [
  "minecraft:command_block",
  "minecraft:repeating_command_block",
  "minecraft:chain_command_block",
];
const DIMENSIONS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];
const LOG_KEY = "mlc:cmdLog";
const LOG_MAX = 20;

const lastScanned = new Map();
let queue = [];
let urgent = false;

export function requestUrgentScan() {
  urgent = true;
}

export function getRemovalLog() {
  try {
    return JSON.parse(String(world.getDynamicProperty(LOG_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

function addLog(entry) {
  const log = getRemovalLog();
  log.unshift(entry);
  world.setDynamicProperty(LOG_KEY, JSON.stringify(log.slice(0, LOG_MAX)));
}

function rebuildQueue() {
  if (urgent) {
    lastScanned.clear();
    urgent = false;
  }
  const now = system.currentTick;
  const seen = new Set();
  const jobs = [];
  const radius = CONFIG.commandBlock.scanChunkRadius;
  for (const player of world.getAllPlayers()) {
    const dimensionId = player.dimension.id;
    const pcx = Math.floor(player.location.x / 16);
    const pcz = Math.floor(player.location.z / 16);
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const key = `${dimensionId}|${pcx + dx}|${pcz + dz}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const last = lastScanned.get(key);
        if (last !== undefined && now - last < CONFIG.commandBlock.rescanTicks) continue;
        jobs.push({ key, dimensionId, cx: pcx + dx, cz: pcz + dz, dist: dx * dx + dz * dz });
      }
    }
  }
  jobs.sort((a, b) => a.dist - b.dist);
  queue = jobs;
}

function removeCommandBlock(dimension, location) {
  if (tempCommandBlocks.has(blockKey(dimension.id, location))) return; // 밴 kick 용 커맨드 블록
  const block = dimension.getBlock(location);
  if (!block) return;
  const type = block.typeId.replace("minecraft:", "");
  const where = `${shortDimension(dimension.id)} ${formatLocation(location)}`;
  if (CONFIG.commandBlock.remove) {
    block.setType("minecraft:air");
    addLog({ type, where, time: Date.now() });
    queueAdminNotice(`§c커맨드 블록 제거§r: ${type} @ ${where}`);
  } else {
    queueAdminNotice(`§e커맨드 블록 발견§r: ${type} @ ${where}`);
  }
}

function scanChunk(job) {
  const dimension = world.getDimension(job.dimensionId);
  const { min, max } = dimension.heightRange;
  const volume = new BlockVolume(
    { x: job.cx * 16, y: min, z: job.cz * 16 },
    { x: job.cx * 16 + 15, y: max - 1, z: job.cz * 16 + 15 }
  );
  let found;
  try {
    found = dimension.getBlocks(volume, { includeTypes: COMMAND_BLOCKS }, false);
  } catch {
    return; // 청크가 로딩되지 않음 - 다음에 다시 시도
  }
  lastScanned.set(job.key, system.currentTick);
  for (const location of found.getBlockLocationIterator()) {
    try {
      removeCommandBlock(dimension, location);
    } catch {}
  }
}

system.runInterval(() => {
  if (!isForceSurvival()) {
    queue = [];
    return;
  }
  if (urgent || queue.length === 0) rebuildQueue();
  // 한 틱에 세 청크씩 검사
  for (let i = 0; i < 3 && queue.length > 0; i++) {
    scanChunk(queue.shift());
  }
}, 1);

// 커맨드 블록 마인카트도 제거
system.runInterval(() => {
  if (!isForceSurvival() || !CONFIG.commandBlock.remove) return;
  for (const id of DIMENSIONS) {
    let carts = [];
    try {
      carts = world.getDimension(id).getEntities({ type: "minecraft:command_block_minecart" });
    } catch {}
    for (const cart of carts) {
      const where = `${shortDimension(id)} ${formatLocation(cart.location)}`;
      try {
        cart.remove();
        addLog({ type: "command_block_minecart", where, time: Date.now() });
        queueAdminNotice(`§c커맨드 블록 마인카트 제거§r @ ${where}`);
      } catch {}
    }
  }
}, 100);
