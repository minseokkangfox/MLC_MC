import {
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandStatus,
  system,
  world,
} from "@minecraft/server";
import { PREFIX, broadcast, isAdmin } from "./util.js";
import { isForceSurvival, setForceSurvival } from "./gamemode.js";
import { getRemovalLog, requestUrgentScan } from "./cmdblock.js";

const HELP = [
  "§e/mlc 게임모드§r - 관리자 제외 모두 강제 서바이벌 + 커맨드 블록 제거 (다시 입력하면 해제)",
  "§e/mlc 상태§r - 현재 상태 보기",
  "§e/mlc 스캔§r - 주변 청크 커맨드 블록 즉시 다시 검사",
  "§e/mlc 로그§r - 제거한 커맨드 블록 위치 보기",
].join("\n");

const fail = (message) => ({ status: CustomCommandStatus.Failure, message: PREFIX + message });
const ok = (message) => ({ status: CustomCommandStatus.Success, message: PREFIX + message });

function run(origin, action) {
  const player = origin.sourceEntity;
  if (!player || player.typeId !== "minecraft:player") return fail("플레이어만 사용할 수 있습니다.");
  if (!isAdmin(player)) return fail("§c관리자만 사용할 수 있는 명령어입니다.");

  switch ((action ?? "").trim().toLowerCase()) {
    case "게임모드":
    case "gamemode":
    case "gm": {
      const enabled = !isForceSurvival();
      system.run(() => {
        setForceSurvival(enabled);
        if (enabled) requestUrgentScan();
        broadcast(enabled ? "§c강제 서바이벌 모드가 켜졌습니다." : "§a강제 서바이벌 모드가 해제되었습니다.");
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
  customCommandRegistry.registerCommand(
    {
      name: "mlc:mlc",
      description: "MLC 렐름 관리 명령어 (관리자 전용)",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
      optionalParameters: [{ name: "action", type: CustomCommandParamType.String }],
    },
    run
  );
});
