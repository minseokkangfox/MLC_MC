import { system } from "@minecraft/server";
import { CONFIG } from "./config.js";

// 서버 로고 + 설명 화면 (처음 들어온 플레이어가 하늘에서 천천히 떨어지는 동안, 관리자는 /hll 로 다시 보기)
// 고화질 로고: 제목을 아래 글자로 보내면 리소스팩 ui/hud_screen.json 이 textures/ui/mlc_logo.png 를 띄움
// (이 글자는 색 코드뿐이라 화면에는 아무 글씨도 안 보임)
export const LOGO_TITLE = "§m§l§c";
// 예전 방식(CONFIG.intro.image = false): font/glyph_E1.png 의 그림 글자 (tools/make_logo_glyph.py)
export const LOGO = "\ue100";

export const INTRO_TICKS = CONFIG.intro.seconds * 20;

/** 로고와 서버 설명을 seconds 초 동안 보여줌 */
export function showIntro(player) {
  // 로고는 한 번만 보냄 (매초 다시 보내면 화면이 툭툭 끊겨 보임)
  if (CONFIG.intro.image) {
    player.onScreenDisplay.setTitle(LOGO_TITLE, { fadeInDuration: 0, stayDuration: INTRO_TICKS, fadeOutDuration: 0 });
  } else {
    player.onScreenDisplay.setTitle(" ", {
      subtitle: LOGO,
      fadeInDuration: 10,
      stayDuration: INTRO_TICKS - 20,
      fadeOutDuration: 10,
    });
  }
  // 아래쪽 설명은 2초마다 다음 줄로
  const lines = [CONFIG.intro.subtitle, ...CONFIG.intro.lines];
  let index = 0;
  const next = () => {
    if (!player.isValid || index * 40 >= INTRO_TICKS) {
      system.clearRun(handle);
      if (player.isValid && CONFIG.intro.image) hideLogo(player);
      return;
    }
    player.onScreenDisplay.setActionBar(lines[index % lines.length]);
    index++;
  };
  const handle = system.runInterval(next, 40);
  next();
}

/** 로고 그림 끄기: 제목 글자가 바뀌어야 그림이 사라짐 (빈 제목은 배경이 투명해서 안 보임) */
function hideLogo(player) {
  try {
    player.onScreenDisplay.setTitle(" ", { fadeInDuration: 0, stayDuration: 1, fadeOutDuration: 0 });
    system.runTimeout(() => {
      if (player.isValid) player.onScreenDisplay.clearTitle();
    }, 2);
  } catch {}
}
