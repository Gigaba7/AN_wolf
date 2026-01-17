// ルーレット機能

import { GameState, $, $$ } from "./game-state.js";
import { closeAllRouletteModals } from "./ui-modals.js";
import { syncToFirebase } from "./firebase-sync.js";
import { getStageCandidatesByChapterRange } from "./stage-data.js";

function startStageRoulette() {
  const itemsEl = $("#stage-roulette-items");
  if (!itemsEl) return;

  itemsEl.innerHTML = "";
  const min = GameState.options.stageMinChapter;
  const max = GameState.options.stageMaxChapter;
  const stages = getStageCandidatesByChapterRange(min, max);

  // 候補が多い場合、表示は10件程度に絞って演出を軽量化（ただし選出は全候補に対して一様）
  // 候補が多い場合でも見た目が寂しくならないよう、表示は「10件より多く」出す
  const DISPLAY_LIMIT = 12;
  const shouldSample = stages.length > 60;
  const displayStages = shouldSample ? sampleUnique(stages, Math.min(DISPLAY_LIMIT, stages.length)) : stages;

  displayStages.forEach((stage) => {
    const item = document.createElement("div");
    item.className = "roulette-item";
    item.textContent = stage;
    itemsEl.appendChild(item);
  });

  let currentIndex = 0;
  let prevIndex = -1;
  const items = Array.from(itemsEl.querySelectorAll(".roulette-item"));
  if (items.length === 0) return;
  const interval = setInterval(() => {
    if (prevIndex >= 0 && items[prevIndex]) items[prevIndex].classList.remove("active");
    if (items[currentIndex]) items[currentIndex].classList.add("active");
    prevIndex = currentIndex;
    currentIndex = (currentIndex + 1) % items.length;
  }, 50);

  setTimeout(() => {
    clearInterval(interval);
    // 選出は「表示候補」から選ぶ（サンプル方式でも全候補に対して一様になる）
    const selected = displayStages[Math.floor(Math.random() * displayStages.length)];
    items.forEach((el) => el.classList.remove("active"));
    const selectedEl = items.find((el) => el.textContent === selected);
    if (selectedEl) selectedEl.classList.add("selected");

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

function sampleUnique(arr, n) {
  // Fisher–Yates の部分シャッフルで n 件だけ取り出す（均一な部分集合）
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
