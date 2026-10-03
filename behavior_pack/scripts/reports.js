import { world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { CONFIG } from "./config.js";
import { PREFIX, isAdmin, notifyAdmins } from "./util.js";
import { PLAYER_ICON, formatTime, playerButtonText, showForm, timeAgo } from "./forms.js";
import { getKnownPlayers } from "./players.js";
import { addJoinSummary } from "./inbox.js";
import { showBanDetails } from "./bans.js";

const REPORT_PREFIX = "mlc:rep:";
const SEQ_KEY = "mlc:repSeq";

/**
 * @typedef {{ seq: number, reporterId: string, reporterName: string, targetId: string, targetName: string,
 *   category: string, title: string, details: string, screenshot: string, time: number, read: boolean }} Report
 * @returns {Report[]}
 */
function getReports() {
  const reports = [];
  for (const key of world.getDynamicPropertyIds()) {
    if (!key.startsWith(REPORT_PREFIX)) continue;
    try {
      reports.push(JSON.parse(String(world.getDynamicProperty(key))));
    } catch {}
  }
  return reports.sort((a, b) => b.time - a.time);
}

function saveReport(report) {
  world.setDynamicProperty(REPORT_PREFIX + report.seq, JSON.stringify(report));
}

function deleteReport(report) {
  world.setDynamicProperty(REPORT_PREFIX + report.seq, undefined);
}

// 관리자가 나중에 접속해도 안 읽은 신고가 있으면 관리자에게만 알림
addJoinSummary(() => {
  const unread = getReports().filter((r) => !r.read).length;
  return unread > 0 ? `§c새 신고 ${unread}건§r이 있습니다. §e/신고함§r 으로 확인하세요.` : undefined;
});

// ---------- /신고 ----------

export async function openReportMenu(player) {
  const players = getKnownPlayers().filter((p) => p.id !== player.id);
  if (players.length === 0) {
    player.sendMessage(PREFIX + "신고할 수 있는 플레이어가 없습니다.");
    return;
  }
  const list = new ActionFormData().title("플레이어 신고").body("신고할 플레이어를 선택하세요.\n위: 접속 중 / 아래: 나간 플레이어");
  for (const p of players) list.button(playerButtonText(p), PLAYER_ICON);
  const picked = await showForm(player, list);
  if (!picked || picked.canceled || picked.selection === undefined) return;
  const target = players[picked.selection];

  if (getReports().some((r) => r.reporterId === player.id && r.targetId === target.id)) {
    player.sendMessage(PREFIX + `§c이미 ${target.name} 님을 신고했습니다.§r 같은 플레이어는 한 번만 신고할 수 있습니다.`);
    return;
  }

  const categories = CONFIG.report.categories;
  const form = new ModalFormData()
    .title(`${target.name} 신고`)
    .dropdown("신고 종류", categories)
    .textField("제목", "예: 스폰 건물 부숨")
    .textField("자세한 설명", "언제, 어디서, 무엇을 했는지 적어주세요 (좌표가 있으면 좋아요)")
    .textField("스크린샷 링크 (선택)", "디스코드 등에 올린 사진 링크를 붙여넣으세요")
    .submitButton("§c신고 전송");
  const response = await showForm(player, form);
  if (!response || response.canceled || !response.formValues) return;
  const [categoryIndex, title, details, screenshot] = response.formValues;

  // 폼을 작성하는 동안 중복 신고가 들어왔는지 다시 확인
  if (getReports().some((r) => r.reporterId === player.id && r.targetId === target.id)) return;

  const seq = Number(world.getDynamicProperty(SEQ_KEY) ?? 0) + 1;
  world.setDynamicProperty(SEQ_KEY, seq);
  const category = categories[Number(categoryIndex)] ?? categories[0];
  /** @type {Report} */
  const report = {
    seq,
    reporterId: player.id,
    reporterName: player.name,
    targetId: target.id,
    targetName: target.name,
    category,
    title: String(title ?? "").trim().slice(0, 60) || category,
    details: String(details ?? "").trim().slice(0, 800),
    screenshot: String(screenshot ?? "").trim().slice(0, 300),
    time: Date.now(),
    read: false,
  };
  saveReport(report);
  player.sendMessage(PREFIX + `§a${target.name} 님에 대한 신고가 관리자에게 전송되었습니다.`);
  notifyAdmins(`§c새 신고!§r ${report.reporterName} → §e${report.targetName}§r [${category}] ${report.title} §7(/신고함)`);
}

// ---------- /신고함 (관리자) ----------

export async function openReportInbox(admin) {
  if (!isAdmin(admin)) return;
  while (admin.isValid) {
    const reports = getReports();
    if (reports.length === 0) {
      admin.sendMessage(PREFIX + "신고함이 비어 있습니다.");
      return;
    }
    const groups = new Map();
    for (const r of reports) {
      let g = groups.get(r.targetId);
      if (!g) groups.set(r.targetId, (g = { id: r.targetId, name: r.targetName, reports: [], unread: 0 }));
      g.reports.push(r);
      if (!r.read) g.unread++;
    }
    const targets = [...groups.values()].sort((a, b) => b.reports.length - a.reports.length);
    const list = new ActionFormData().title("신고함").body(`신고 당한 플레이어 ${targets.length}명 (많이 신고된 순)`);
    for (const t of targets) {
      const unread = t.unread > 0 ? ` §c(새 신고 ${t.unread})` : "";
      list.button(`§0${t.name}\n§4신고 ${t.reports.length}회${unread}`, PLAYER_ICON);
    }
    const picked = await showForm(admin, list);
    if (!picked || picked.canceled || picked.selection === undefined) return;
    const result = await showTargetReports(admin, targets[picked.selection]);
    if (result === "close") return;
  }
}

async function showTargetReports(admin, target) {
  while (admin.isValid) {
    const reports = getReports().filter((r) => r.targetId === target.id);
    if (reports.length === 0) return "back";
    const form = new ActionFormData()
      .title(`${target.name} - 신고 ${reports.length}회`)
      .body("이 플레이어를 신고한 플레이어 목록입니다. 눌러서 내용을 확인하세요.")
      .button("§c이 플레이어 밴하기");
    for (const r of reports) {
      form.button(`${r.read ? "§0" : "§c● §0"}${r.reporterName} §8[${r.category}]\n§8${r.title} · ${timeAgo(r.time)}`, PLAYER_ICON);
    }
    form.button("§4이 플레이어 신고 모두 삭제").button("뒤로");
    const picked = await showForm(admin, form);
    if (!picked || picked.canceled || picked.selection === undefined) return "close";
    const sel = picked.selection;
    if (sel === 0) {
      await showBanDetails(admin, { id: target.id, name: target.name }, reports[0].category);
      return "close";
    }
    if (sel === reports.length + 1) {
      for (const r of reports) deleteReport(r);
      admin.sendMessage(PREFIX + `${target.name} 에 대한 신고를 모두 삭제했습니다.`);
      return "back";
    }
    if (sel === reports.length + 2) return "back";
    const result = await showReportDetail(admin, reports[sel - 1]);
    if (result === "close") return "close";
  }
  return "close";
}

async function showReportDetail(admin, report) {
  if (!report.read) {
    report.read = true;
    saveReport(report);
  }
  const form = new ActionFormData()
    .title(`신고 #${report.seq}`)
    .body(
      `§e신고 대상:§r ${report.targetName}\n§e신고자:§r ${report.reporterName}\n§e종류:§r ${report.category}\n` +
        `§e날짜:§r ${formatTime(report.time)}\n\n§e제목:§r ${report.title}\n\n§e자세한 설명:§r\n${report.details || "(없음)"}\n\n` +
        `§e스크린샷:§r ${report.screenshot || "(없음)"}`
    )
    .button("뒤로")
    .button("§c신고 대상 밴하기")
    .button("§4이 신고 삭제");
  const picked = await showForm(admin, form);
  if (!picked || picked.canceled) return "close";
  if (picked.selection === 1) {
    await showBanDetails(admin, { id: report.targetId, name: report.targetName }, report.category);
    return "close";
  }
  if (picked.selection === 2) deleteReport(report);
  return "back";
}
