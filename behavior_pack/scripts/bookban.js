import { system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { PREFIX, formatLocation, notifyAdmins, shortDimension, utf8Length } from "./util.js";

// 북밴 방지: 비정상적으로 용량이 큰 책 / 셜커 상자를 제거합니다.
// 아이템 크기는 책 내용, 제목, 이름, 설명(lore), 다이나믹 프로퍼티의 UTF-8 바이트 수로 추정합니다.

const BOOKS = new Set(["minecraft:written_book", "minecraft:writable_book"]);
const isShulker = (typeId) => typeId.endsWith("shulker_box");
const cfg = CONFIG.bookBan;

function itemBytes(item, depth = 0) {
  let bytes = utf8Length(item.typeId);
  try {
    bytes += utf8Length(item.nameTag);
  } catch {}
  try {
    for (const line of item.getLore()) bytes += utf8Length(line);
  } catch {}
  try {
    bytes += item.getDynamicPropertyTotalByteCount();
  } catch {}
  try {
    const book = item.getComponent("minecraft:book");
    if (book) {
      bytes += utf8Length(book.title) + utf8Length(book.author);
      for (const page of book.contents) bytes += utf8Length(page);
      for (const raw of book.rawContents) if (raw) bytes += utf8Length(JSON.stringify(raw));
    }
  } catch {}
  if (depth < 3 && isShulker(item.typeId)) {
    try {
      const inner = item.getComponent("minecraft:inventory")?.container;
      if (inner) bytes += containerBytes(inner, depth + 1);
    } catch {}
  }
  return bytes * Math.max(1, item.amount);
}

function containerBytes(container, depth = 0) {
  let total = 0;
  for (let i = 0; i < container.size; i++) {
    const item = container.getItem(i);
    if (item) total += itemBytes(item, depth);
  }
  return total;
}

/** 이 아이템이 북밴용으로 의심되면 이유 문자열, 아니면 undefined */
function badItemReason(item) {
  if (BOOKS.has(item.typeId)) {
    const bytes = itemBytes(item);
    if (bytes > cfg.maxBookBytes) return `책 용량 ${bytes}B`;
  } else if (isShulker(item.typeId)) {
    const bytes = itemBytes(item);
    if (bytes > cfg.maxShulkerBytes) return `셜커 용량 ${bytes}B`;
  }
  return undefined;
}

/** 컨테이너 안의 위험한 책/셜커를 지움. 지운 개수 반환 */
function purgeContainer(container, label) {
  let removed = 0;
  for (let i = 0; i < container.size; i++) {
    const item = container.getItem(i);
    if (!item) continue;
    const reason = badItemReason(item);
    if (reason) {
      container.setItem(i, undefined);
      removed++;
      notifyAdmins(`§c북밴 의심 아이템 제거§r (${reason}) - ${label}`);
    }
  }
  return removed;
}

/** 설치된 셜커 상자 블럭 검사: 전체 용량이 크면 블럭째 제거 */
function checkContainerBlock(block, who) {
  if (!cfg.enabled) return;
  const container = block.getComponent("minecraft:inventory")?.container;
  if (!container) return;
  const where = `${shortDimension(block.dimension.id)} ${formatLocation(block.location)}`;
  if (isShulker(block.typeId)) {
    const bytes = containerBytes(container);
    if (bytes > cfg.maxShulkerBytes) {
      destroyShulker(block.dimension, block.location, bytes, who);
      return;
    }
  }
  purgeContainer(container, `${block.typeId.replace("minecraft:", "")} @ ${where}`);
}

/** 설치된 셜커의 내용물 용량 (읽기 전용 모드에서도 가능) */
function placedShulkerBytes(block) {
  const container = block.getComponent("minecraft:inventory")?.container;
  return container ? containerBytes(container) : 0;
}

function destroyShulker(dimension, location, bytes, who) {
  const block = dimension.getBlock(location);
  if (!block || !isShulker(block.typeId)) return;
  block.getComponent("minecraft:inventory")?.container?.clearAll();
  block.setType("minecraft:air");
  notifyAdmins(`§c북밴 의심 셜커 상자 제거§r (${bytes}B) @ ${shortDimension(dimension.id)} ${formatLocation(location)}${who ? ` (${who})` : ""}`);
}

// 셜커를 부수는 순간 검사: 아이템이 된 셜커는 스크립트로 안을 볼 수 없어서,
// 땅에 떨어져 다른 사람이 줍기 전에 블럭 상태일 때 막아야 함
world.beforeEvents.playerBreakBlock.subscribe((event) => {
  if (!cfg.enabled || !isShulker(event.block.typeId)) return;
  let bytes = 0;
  try {
    bytes = placedShulkerBytes(event.block);
  } catch {}
  if (bytes <= cfg.maxShulkerBytes) return;
  event.cancel = true;
  const dimension = event.block.dimension;
  const location = { ...event.block.location };
  const who = event.player.name;
  system.run(() => destroyShulker(dimension, location, bytes, who));
});

// 폭발로 셜커가 아이템이 되는 것도 막음
world.beforeEvents.explosion.subscribe((event) => {
  if (!cfg.enabled) return;
  const blocks = event.getImpactedBlocks();
  const bad = [];
  const kept = blocks.filter((block) => {
    if (!isShulker(block.typeId)) return true;
    let bytes = 0;
    try {
      bytes = placedShulkerBytes(block);
    } catch {}
    if (bytes <= cfg.maxShulkerBytes) return true;
    bad.push({ location: { ...block.location }, bytes });
    return false;
  });
  if (bad.length === 0) return;
  event.setImpactedBlocks(kept);
  const dimension = event.dimension;
  system.run(() => {
    for (const { location, bytes } of bad) destroyShulker(dimension, location, bytes);
  });
});

world.afterEvents.playerPlaceBlock.subscribe(({ block, player }) => {
  if (isShulker(block.typeId)) checkContainerBlock(block, player.name);
});

world.afterEvents.playerInteractWithBlock.subscribe(({ block, player }) => {
  try {
    if (block.getComponent("minecraft:inventory")) checkContainerBlock(block, player.name);
  } catch {}
});

// 땅에 떨어진 아이템
world.afterEvents.entitySpawn.subscribe(({ entity }) => {
  if (!cfg.enabled || entity.typeId !== "minecraft:item") return;
  try {
    const item = entity.getComponent("minecraft:item")?.itemStack;
    if (!item) return;
    const reason = badItemReason(item);
    if (reason) {
      const where = `${shortDimension(entity.dimension.id)} ${formatLocation(entity.location)}`;
      entity.remove();
      notifyAdmins(`§c북밴 의심 아이템(바닥) 제거§r (${reason}) @ ${where}`);
    }
  } catch {}
});

// 플레이어 인벤토리 주기 검사 (접속 직후 포함)
function scanPlayer(player) {
  const container = player.getComponent("minecraft:inventory")?.container;
  if (!container) return;
  if (purgeContainer(container, `${player.name} 인벤토리`) > 0) {
    player.sendMessage(PREFIX + "§c비정상적으로 용량이 큰 책/셜커 상자가 제거되었습니다.");
  }
}

system.runInterval(() => {
  if (!cfg.enabled) return;
  for (const player of world.getAllPlayers()) {
    try {
      scanPlayer(player);
    } catch {}
  }
}, cfg.scanIntervalTicks);

world.afterEvents.playerSpawn.subscribe(({ player }) => {
  if (!cfg.enabled) return;
  system.run(() => {
    try {
      if (player.isValid) scanPlayer(player);
    } catch {}
  });
});
