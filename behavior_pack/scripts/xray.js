import { system, world } from "@minecraft/server";
import { formatLocation, isAdmin, notifyAdmins, shortDimension } from "./util.js";
import { queueAdminNotice } from "./inbox.js";

// 엑스레이 막기
// 1) 블럭 속 끼임 엑스레이: 머리(카메라)가 돌·흙 같은 꽉 찬 블럭 안에 들어가면 땅속이 다 보이는 버그.
//    머리가 블럭 안에 있으면 즉시 실명+어둠 효과로 아무것도 안 보이게 하고, 2초 넘게 끼어 있으면 위쪽 빈칸으로 빼냄.
// 2) 엑스레이 리소스팩(투명 텍스처) 의심: 스크립트로 리소스팩을 막을 수는 없어서,
//    돌에 비해 다이아/에메랄드/고대 잔해를 비정상적으로 많이 캐면 관리자에게 알림.

const SOLID_WORDS = ["stone", "deepslate", "dirt", "grass_block", "netherrack", "sand", "gravel", "_ore", "tuff", "granite", "diorite", "andesite", "calcite", "basalt", "clay", "terracotta", "mud", "moss_block", "soul_soil", "soul_sand", "ancient_debris", "bedrock", "obsidian", "end_stone", "podzol", "mycelium"];
const NOT_FULL_WORDS = ["slab", "stairs", "wall", "button", "plate", "pointed", "fence", "pane", "carpet", "torch", "lantern", "_head", "sign", "trapdoor", "door", "rod", "cluster", "bud", "sapling", "farmland", "dirt_path", "layer", "wire"];

function isFullSolid(typeId) {
  return SOLID_WORDS.some((w) => typeId.includes(w)) && !NOT_FULL_WORDS.some((w) => typeId.includes(w));
}

const stuckTicks = new Map(); // 플레이어 id -> 끼어 있던 횟수

system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    if (isAdmin(player)) continue;
    try {
      const head = player.getHeadLocation();
      const block = player.dimension.getBlock({ x: Math.floor(head.x), y: Math.floor(head.y), z: Math.floor(head.z) });
      if (!block || !isFullSolid(block.typeId)) {
        stuckTicks.delete(player.id);
        continue;
      }
      player.addEffect("blindness", 40, { showParticles: false });
      player.addEffect("darkness", 40, { showParticles: false });
      const n = (stuckTicks.get(player.id) ?? 0) + 1;
      stuckTicks.set(player.id, n);
      if (n >= 10) {
        // 2초 넘게 끼어 있음 → 위쪽 빈 공간으로 빼냄
        const base = player.location;
        for (let dy = 1; dy <= 4; dy++) {
          const feet = player.dimension.getBlock({ x: Math.floor(base.x), y: Math.floor(base.y) + dy, z: Math.floor(base.z) });
          const top = feet?.above();
          if (feet && top && !isFullSolid(feet.typeId) && !isFullSolid(top.typeId)) {
            player.teleport({ x: base.x, y: Math.floor(base.y) + dy, z: base.z });
            break;
          }
        }
        stuckTicks.delete(player.id);
      }
    } catch {}
  }
}, 4);

// ---------- 캐는 패턴으로 엑스레이 의심 ----------
const VALUABLE = new Set(["minecraft:diamond_ore", "minecraft:deepslate_diamond_ore", "minecraft:ancient_debris", "minecraft:emerald_ore", "minecraft:deepslate_emerald_ore"]);
const COMMON = new Set(["minecraft:stone", "minecraft:deepslate", "minecraft:tuff", "minecraft:netherrack", "minecraft:granite", "minecraft:diorite", "minecraft:andesite", "minecraft:basalt", "minecraft:blackstone", "minecraft:cobbled_deepslate"]);
const WINDOW_MS = 30 * 60 * 1000;
const mining = new Map(); // 플레이어 id -> { valuable: [시각], common: [시각], lastReport }

world.afterEvents.playerBreakBlock.subscribe(({ player, brokenBlockPermutation, block }) => {
  const typeId = brokenBlockPermutation.type.id;
  const isValuable = VALUABLE.has(typeId);
  if (!isValuable && !COMMON.has(typeId)) return;
  const now = Date.now();
  const stats = mining.get(player.id) ?? { valuable: [], common: [], lastReport: 0 };
  mining.set(player.id, stats);
  (isValuable ? stats.valuable : stats.common).push(now);
  stats.valuable = stats.valuable.filter((t) => now - t < WINDOW_MS);
  stats.common = stats.common.filter((t) => now - t < WINDOW_MS);
  if (!isValuable) return;
  // 정상: 다이아 광석 1개당 돌 수백 개 / 엑스레이: 1개당 돌 10~20개
  const v = stats.valuable.length;
  const c = stats.common.length;
  if (v >= 10 && v / Math.max(1, c) > 0.06 && now - stats.lastReport > 60 * 60 * 1000) {
    stats.lastReport = now;
    const message = `§e엑스레이 의심§r: ${player.name} - 30분 동안 귀한 광석 ${v}개 / 돌 ${c}개 (위치 ${shortDimension(block.dimension.id)} ${formatLocation(block.location)})`;
    if (world.getAllPlayers().some((p) => isAdmin(p))) notifyAdmins(message);
    else queueAdminNotice(message);
  }
});
