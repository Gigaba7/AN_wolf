// アークナイツ人狼 ツール エントリーポイント

// バージョン情報
const APP_VERSION = "1.3.4";

import { GameState } from "./game-state.js";
import { onAuthStateChanged, signInAnonymously } from "./firebase-auth.js";
import { setupHomeScreen, setupMainScreen, setupParticipantScreen, setupModals } from "./ui-handlers.js";

document.addEventListener("DOMContentLoaded", async () => {
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
  
  // APP_VERSIONをwindowに公開（他のモジュールから参照できるように）
  if (typeof window !== "undefined") {
    window.APP_VERSION = APP_VERSION;
  }
  
  // ゲーム画面にバージョン表示を設定
  const versionDisplay = document.getElementById("game-version-display");
  if (versionDisplay) {
    versionDisplay.textContent = `v${APP_VERSION}`;
  }
});
