import {
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandStatus,
  system,
  world,
} from "@minecraft/server";
import { PREFIX, isAdmin } from "./util.js";
import { isForceSurvival, setForceSurvival } from "./gamemode.js";
import { getRemovalLog, requestUrgentScan } from "./cmdblock.js";
import { openReportInbox, openReportMenu } from "./reports.js";
import { openBanMenu, openUnbanMenu } from "./bans.js";

const HELP = [
  "§e/신고§r - 플레이어 신고 (누구나)",
  "§e/신고함§r - 신고 확인 (관리자)",
  "§e/밴§r, §e/밴해제§r - 밴 / 밴 해제 (관리자)",
  "§e/mlc 게임모드§r - 관리자 제외 모두 강제 서바이벌 + 커맨드 블록 제거 (다시 입력하면 해제)",
  "§e/mlc 상태§r, §e/mlc 스캔§r, §e/mlc 로그§r",
].join("\n");

const fail = (message) => ({ status: CustomCommandStatus.Failure, message: PREFIX + message });
const ok = (message) => ({ status: CustomCommandStatus.Success, message: PREFIX + message });

function getPlayer(origin) {
  const entity = origin.sourceEntity;
  return entity?.typeId === "minecraft:player" ? /** @type {import("@minecraft/server").Player} */ (entity) : undefined;
}

/** 폼을 여는 명령어: 읽기 전용 모드를 벗어난 뒤 실행 */
function formCommand(open, adminOnly) {
  return (origin) => {
    const player = getPlayer(origin);
    if (!player) return fail("플레이어만 사용할 수 있습니다.");
    if (adminOnly && !isAdmin(player)) return fail("§c관리자만 사용할 수 있는 명령어입니다.");
    system.run(() => {
      open(player).catch(() => {});
    });
    return { status: CustomCommandStatus.Success };
  };
}

const report = formCommand(openReportMenu, false);
const reportInbox = formCommand(openReportInbox, true);
const ban = formCommand(openBanMenu, true);
const unban = formCommand(openUnbanMenu, true);

function mlc(origin, action) {
  const keyword = (action ?? "").trim().toLowerCase();
  if (keyword === "신고" || keyword === "report") return report(origin);
  const player = getPlayer(origin);
  if (!player) return fail("플레이어만 사용할 수 있습니다.");
  if (!isAdmin(player)) return fail("§c관리자만 사용할 수 있는 명령어입니다.");

  switch (keyword) {
    case "신고함":
    case "reports":
      return reportInbox(origin);
    case "밴":
    case "ban":
      return ban(origin);
    case "밴해제":
    case "unban":
      return unban(origin);
    case "게임모드":
    case "gamemode":
    case "gm": {
      const enabled = !isForceSurvival();
      system.run(() => {
        setForceSurvival(enabled);
        if (enabled) requestUrgentScan();
      });
      return ok(
        enabled
          ? "강제 서바이벌 §aON§r - 관리자 외 전원 서바이벌 고정, 로딩된 청크의 커맨드 블록을 찾아 제거합니다."
          : "강제 서바이벌 §cOFF§r"
      );
    }
    case "상태":
    case "status":
      return ok(
        `강제 서바이벌: ${isForceSurvival() ? "§aON" : "§cOFF"}§r, 접속자 ${world.getAllPlayers().length}명, ` +
          `제거한 커맨드 블록 ${getRemovalLog().length}개(최근 기록)`
      );
    case "스캔":
    case "scan":
      if (!isForceSurvival()) return fail("먼저 /mlc 게임모드 로 강제 서바이벌을 켜 주세요.");
      requestUrgentScan();
      return ok("주변 청크를 다시 검사합니다.");
    case "로그":
    case "log": {
      const log = getRemovalLog();
      if (log.length === 0) return ok("아직 제거한 커맨드 블록이 없습니다.");
      return ok("제거 기록:\n" + log.map((e) => `- ${e.type} @ ${e.where}`).join("\n"));
    }
    default:
      return ok("명령어 목록\n" + HELP);
  }
}

system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
  const register = (name, description, callback, withAction = false) => {
    try {
      customCommandRegistry.registerCommand(
        {
          name,
          description,
          permissionLevel: CommandPermissionLevel.Any,
          cheatsRequired: false,
          optionalParameters: withAction ? [{ name: "action", type: CustomCommandParamType.String }] : undefined,
        },
        callback
      );
    } catch (error) {
      console.warn(`[MLC] 명령어 등록 실패: ${name} - ${error}`);
    }
  };

  register("mlc:mlc", "MLC 렐름 관리 명령어", mlc, true);
  // 영어 이름 (항상 동작)
  register("mlc:report", "플레이어 신고", report);
  register("mlc:reports", "신고함 (관리자)", reportInbox);
  register("mlc:ban", "플레이어 밴 (관리자)", ban);
  register("mlc:unban", "밴 해제 (관리자)", unban);
  // 한글 이름 (/신고, /신고함, /밴, /밴해제)
  register("mlc:신고", "플레이어 신고", report);
  register("mlc:신고함", "신고함 (관리자)", reportInbox);
  register("mlc:밴", "플레이어 밴 (관리자)", ban);
  register("mlc:밴해제", "밴 해제 (관리자)", unban);
});
