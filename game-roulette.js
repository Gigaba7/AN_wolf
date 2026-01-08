// ルーレット機能

import { GameState, $, $$ } from "./game-state.js";
import { closeAllRouletteModals } from "./ui-modals.js";
import { syncToFirebase } from "./firebase-sync.js";

// 妨害ルーレット機能は廃止（任意選択方式に変更）
// 後方互換性のため関数は残すが、使用されない
function startWolfRoulette() {
  console.warn("startWolfRoulette is deprecated. Use wolf action selection UI instead.");
}

async function useWolfAction(action) {
  console.warn("useWolfAction is deprecated. Use activateWolfAction instead.");
}

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
      // モーダルを自動で閉じる（結果表示後）
      setTimeout(() => {
        const modal = document.getElementById("stage-roulette-modal");
        if (modal) {
          modal.classList.add("hidden");
        }
      }, 900);
    }, 1000);
  }, 2000);
}

export { startWolfRoulette, useWolfAction, startStageRoulette };
