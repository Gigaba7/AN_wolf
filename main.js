// アークナイツ人狼 ツール エントリーポイント

import { GameState } from "./game-state.js";
import { onAuthStateChanged, signInAnonymously } from "./firebase-auth.js";
import { setupHomeScreen, setupMainScreen, setupModals } from "./ui-handlers.js";
import { logSystem } from "./game-logging.js";

document.addEventListener("DOMContentLoaded", async () => {
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
  setupModals();
  logSystem("ツールが起動しました。ホーム画面からルーム作成または参加を選択してください。");
});
