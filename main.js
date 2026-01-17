// アークナイツ人狼 ツール エントリーポイント

// バージョン情報
const APP_VERSION = "1.1.24";

import { GameState } from "./game-state.js";
import { onAuthStateChanged, signInAnonymously } from "./firebase-auth.js";
import { setupHomeScreen, setupMainScreen, setupParticipantScreen, setupModals } from "./ui-handlers.js";

function applyObsCanvasFit() {
  const app = document.getElementById("app");
  if (!app) return;

  const baseW = 1920;
  const baseH = 1080;
  const vw = Math.max(1, window.innerWidth || 1);
  const vh = Math.max(1, window.innerHeight || 1);

  const scale = Math.min(vw / baseW, vh / baseH, 1);
  const scaledW = baseW * scale;
  const scaledH = baseH * scale;
  const left = Math.max(0, (vw - scaledW) / 2);
  const top = Math.max(0, (vh - scaledH) / 2);

  app.style.width = `${baseW}px`;
  app.style.height = `${baseH}px`;
  app.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
}

document.addEventListener("DOMContentLoaded", async () => {
  applyObsCanvasFit();
  window.addEventListener("resize", () => requestAnimationFrame(applyObsCanvasFit));

  // バージョン情報をコンソールに表示
  console.log(
    `%cレユニオン人狼 用ファンメイド支援ツール`,
    "font-size: 16px; font-weight: bold; color: #8be6c3;"
  );
  console.log(
    `%cVersion: ${APP_VERSION}`,
    "font-size: 12px; color: #a0a4ba;"
  );
  console.log(
    `%c─────────────────────────────────`,
    "color: #555;"
  );
  // 認証状態を監視
  onAuthStateChanged((user) => {
    if (user) {
      console.log('User authenticated:', user.uid);
    }
  });
  
  // 匿名認証でログイン
  try {
    await signInAnonymously();
  } catch (error) {
    console.error('Failed to sign in:', error);
  }
  
  setupHomeScreen();
  setupMainScreen();
  setupParticipantScreen();
  setupModals();
});
