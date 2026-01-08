// ルーレット機能

import { GameState, $, $$ } from "./game-state.js";
import { closeAllRouletteModals } from "./ui-modals.js";
import { syncToFirebase } from "./firebase-sync.js";

function startStageRoulette() {
  const itemsEl = $("#stage-roulette-items");
  if (!itemsEl) return;

  itemsEl.innerHTML = "";
  const min = GameState.options.stageMinChapter;
  const max = GameState.options.stageMaxChapter;
  const stages = [];

  for (let ch = min; ch <= max; ch++) {
    for (let st = 1; st <= 10; st++) {
      stages.push(`${ch}-${st}`);
    }
  }

  stages.forEach((stage) => {
    const item = document.createElement("div");
    item.className = "roulette-item";
    item.textContent = stage;
    itemsEl.appendChild(item);
  });

  let currentIndex = 0;
  const interval = setInterval(() => {
    $$(".roulette-item").forEach((el, idx) => {
      el.classList.toggle("active", idx === currentIndex);
    });
    currentIndex = (currentIndex + 1) % stages.length;
  }, 50);

  setTimeout(() => {
    clearInterval(interval);
    const selected = stages[Math.floor(Math.random() * stages.length)];
    $$(".roulette-item").forEach((el) => {
      el.classList.remove("active");
      if (el.textContent === selected) {
        el.classList.add("selected");
      }
    });

    // ルーレットの停止位置で1秒停止
    setTimeout(() => {
      // Firebase同期（結果はsnapshotで全員に反映）
      const roomId = typeof window !== "undefined" && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
      if (roomId) {
        syncToFirebase("stageRoulette", {
          stageName: selected,
          roomId,
        }).catch((error) => {
          console.error("Failed to sync stage:", error);
        });
      }
      // モーダルを自動で閉じる（停止位置で1秒停止後）
      const modal = document.getElementById("stage-roulette-modal");
      if (modal) {
        modal.classList.add("hidden");
      }
    }, 1000);
  }, 2000);
}

export { startStageRoulette };
