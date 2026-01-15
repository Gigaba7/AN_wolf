// ゲーム結果表示

import { GameState, $ } from "./game-state.js";
import { openModal } from "./ui-modals.js";
import { syncToFirebase } from "./firebase-sync.js";

function checkGameEnd() {
  if (GameState.resultLocked) return;

  const total = GameState.whiteStars + GameState.blackStars;
  if (total < GameState.maxTurns) return;

  GameState.resultLocked = true;

  // Firebase同期
  const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  if (roomId) {
    syncToFirebase('gameEnd', { 
      logMessage: 'ゲーム終了',
      roomId
    }).catch(error => {
      console.error('Failed to sync game end:', error);
    });
  }

  const whiteCount = GameState.whiteStars;
  const blackCount = GameState.blackStars;
  const doctor = GameState.players.find((p) => p.role === "doctor");

  if (GameState.doctorFailed) {
    showResult("レユニオンの勝利", "ドクターが失敗したため、レユニオンの勝利です。");
  } else if (blackCount > whiteCount) {
    if (doctor && !GameState.doctorFailed) {
      showGuessWolfModal();
      return;
    }
    showResult("レユニオンの勝利", "黒星が過半数を占めたため、レユニオンの勝利です。");
  } else {
    showResult("ロドス陣営の勝利", "白星が過半数を占めたため、ロドス陣営の勝利です。");
  }
}

function showResult(title, summary) {
  const titleEl = $("#result-title");
  const sumEl = $("#result-summary");
  const rolesEl = $("#result-roles");

  if (titleEl) titleEl.textContent = title;
  if (sumEl) sumEl.textContent = summary;

  if (rolesEl) {
    rolesEl.innerHTML = "";
    const rolesList = document.createElement("div");
    rolesList.className = "result-roles-list";

    GameState.players.forEach((p) => {
      const roleLabel =
        p.role === "doctor"
          ? "ドクター"
          : p.role === "wolf"
          ? "レユニオン"
          : "オペレーター";
      const roleClass =
        p.role === "doctor"
          ? "role-doctor"
          : p.role === "wolf"
          ? "role-wolf"
          : "role-citizen";
      
      const roleItem = document.createElement("div");
      roleItem.style.display = "flex";
      roleItem.style.alignItems = "center";
      roleItem.style.gap = "8px";
      roleItem.style.padding = "6px 8px";
      roleItem.style.borderRadius = "6px";
      roleItem.style.background = "rgba(255, 255, 255, 0.03)";
      roleItem.innerHTML = `
        <span style="font-weight: 500;">${p.name}</span>
        <span class="player-role-tag ${roleClass}" style="margin-left: auto;">${roleLabel}</span>
      `;
      rolesList.appendChild(roleItem);
    });
    
    rolesEl.appendChild(rolesList);
  }
  
  openModal("result-modal");
}

function showGuessWolfModal() {
  const extraEl = $("#result-extra");
  if (!extraEl) return;

  const wolves = GameState.players.filter((p) => p.role === "wolf");
  const realWolf = wolves[0];

  extraEl.innerHTML = "";
  const info = document.createElement("p");
  info.textContent =
    "GMは各プレイヤーからの投票結果に応じて、レユニオンだと思うプレイヤーを1名選択してください。";
  extraEl.appendChild(info);

  const btnWrap = document.createElement("div");
  btnWrap.style.display = "flex";
  btnWrap.style.flexWrap = "wrap";
  btnWrap.style.gap = "6px";
  btnWrap.style.marginTop = "8px";

  GameState.players.forEach((p) => {
    const b = document.createElement("button");
    b.className = "btn ghost small";
    b.textContent = p.name;
    b.addEventListener("click", () => {
      const isWolf = p.id === realWolf.id;
      if (isWolf) {
        showResult("ロドス陣営の勝利", "レユニオンを正しく特定したため、ロドス陣営の勝利です。");
      } else {
        showResult("レユニオンの勝利", "レユニオンを特定できなかったため、レユニオンの勝利です。");
      }
    });
    btnWrap.appendChild(b);
  });

  extraEl.appendChild(btnWrap);

  const titleEl = $("#result-title");
  const sumEl = $("#result-summary");
  if (titleEl) titleEl.textContent = "最終判定: レユニオン指名フェーズ";
  if (sumEl)
    sumEl.textContent =
      "黒星が過半数ですが、ドクターは一度も失敗していません。プレイヤーからの話し合いをもとに、レユニオンを1名指名してください。";

  openModal("result-modal");
}

export { checkGameEnd, showResult, showGuessWolfModal };
