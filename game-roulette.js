// ルーレット機能

import { GameState, $, $$ } from "./game-state.js";
import { closeAllRouletteModals } from "./ui-modals.js";
import { syncToFirebase } from "./firebase-sync.js";
import { logSystem, logTurn } from "./game-logging.js";
import { renderAll } from "./ui-render.js";

function startWolfRoulette() {
  const itemsEl = $("#wolf-roulette-items");
  if (!itemsEl) return;

  itemsEl.innerHTML = "";
  const actions = GameState.options.wolfActionTexts;

  actions.forEach((action) => {
    const item = document.createElement("div");
    item.className = "roulette-item";
    item.textContent = action;
    itemsEl.appendChild(item);
  });

  let currentIndex = 0;
  const interval = setInterval(() => {
    $$(".roulette-item").forEach((el, idx) => {
      el.classList.toggle("active", idx === currentIndex);
    });
    currentIndex = (currentIndex + 1) % actions.length;
  }, 100);

  setTimeout(() => {
    clearInterval(interval);
    const selected = actions[Math.floor(Math.random() * actions.length)];
    $$(".roulette-item").forEach((el) => {
      el.classList.remove("active");
      if (el.textContent === selected) {
        el.classList.add("selected");
      }
    });

    setTimeout(() => {
      closeAllRouletteModals();
      useWolfAction(selected);
    }, 1000);
  }, 2000);
}

async function useWolfAction(action) {
  GameState.wolfActionsRemaining -= 1;

  // Firebase同期
  const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  if (roomId) {
    try {
      await syncToFirebase('wolfAction', { 
        action: action,
        newWolfActionsRemaining: GameState.wolfActionsRemaining,
        logMessage: `人狼妨害: ${action} が発動されました。`,
        roomId
      });
    } catch (error) {
      console.error('Failed to sync wolf action:', error);
    }
  }

  logTurn(`人狼妨害: ${action} が発動されました。`);
  
  // UIを更新
  renderAll();
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
      closeAllRouletteModals();
      GameState.currentStage = selected;

      // Firebase同期
      const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
      if (roomId) {
        syncToFirebase('stageSelected', { 
          stageName: selected,
          logMessage: `ターン${GameState.turn}のステージ: ${selected}`,
          roomId
        }).catch(error => {
          console.error('Failed to sync stage:', error);
        });
      }

      logSystem(`ターン${GameState.turn}のステージ: ${selected}`);
      
      // UIを更新
      renderAll();
    }, 1000);
  }, 2000);
}

export { startWolfRoulette, useWolfAction, startStageRoulette };
