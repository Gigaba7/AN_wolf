// UI描画管理（ES Module版）

import { GameState, $ } from "./game-state.js";

function renderAll() {
  // グローバルに公開（firebase-sync.jsからアクセス可能にする）
  if (typeof window !== "undefined") {
    window.renderAll = renderAll;
  }

  // 待機画面が表示されている場合は待機画面も更新
  const waitingScreen = $("#waiting-screen");
  if (waitingScreen && waitingScreen.classList.contains("active")) {
    const roomId =
      typeof window !== "undefined" && window.getCurrentRoomId
        ? window.getCurrentRoomId()
        : null;
    if (roomId) {
      renderWaitingScreen(roomId);
      return; // 待機画面の場合はここで終了
    }
  }

  renderStatus();
  renderPlayers();
}

// firebase-sync.js が最初の onSnapshot で UI 更新を呼ぶ前に参照できるように、
// モジュール評価時点でも公開しておく
if (typeof window !== "undefined") {
  window.renderAll = renderAll;
}

function renderStatus() {
  const turnEl = $("#status-turn");
  const starsEl = $("#status-stars");
  const stageEl = $("#status-stage");
  const wolfBtnEl = $("#wolf-remaining-in-button");

  if (turnEl) {
    turnEl.textContent = `${GameState.turn} / ${GameState.maxTurns}`;
  }

  if (starsEl) {
    const whites = "○".repeat(GameState.whiteStars);
    const blacks = "×".repeat(GameState.blackStars);
    const rest = "・".repeat(
      Math.max(0, GameState.maxTurns - GameState.whiteStars - GameState.blackStars)
    );
    starsEl.textContent = whites + blacks + rest;
  }

  if (wolfBtnEl) {
    wolfBtnEl.textContent = `(残り ${GameState.wolfActionsRemaining} 回)`;
  }

  if (stageEl) {
    stageEl.textContent = GameState.currentStage || "未選出";
  }
}

function renderPlayers() {
  const listEl = $("#players-list");
  if (!listEl) return;

  listEl.innerHTML = "";

  GameState.players.forEach((p, idx) => {
    const card = document.createElement("div");
    card.className = "player-card";
    if (idx === GameState.currentPlayerIndex) {
      card.classList.add("current");
    }

    const avatar = document.createElement("div");
    avatar.className = "player-avatar";
    avatar.textContent = p.avatarLetter || "?";

    const name = document.createElement("div");
    name.className = "player-name";
    name.textContent = p.name || "プレイヤー";

    card.appendChild(avatar);
    card.appendChild(name);
    listEl.appendChild(card);
  });
}

function renderWaitingScreen(roomId) {
  const roomIdEl = $("#waiting-room-id");
  const playersListEl = $("#waiting-players-list");
  const playersCountEl = $("#waiting-players-count");
  const startBtn = $("#btn-start-game-from-waiting");

  // ルームIDは画面に表示しない（視聴者乱入防止）。コピー用にdata属性へ保持。
  if (roomIdEl && roomId) {
    roomIdEl.textContent = "••••••";
    roomIdEl.dataset.roomId = roomId;
  }

  // プレイヤーリストを更新（Firebaseから取得）
  if (playersListEl) {
    playersListEl.innerHTML = "";

    if (!GameState.players.length) {
      const empty = document.createElement("div");
      empty.style.gridColumn = "1 / -1";
      empty.style.textAlign = "center";
      empty.style.color = "#a0a4ba";
      empty.style.padding = "12px 0";
      empty.textContent = "参加者を同期中…";
      playersListEl.appendChild(empty);
    } else {
      GameState.players.forEach((player) => {
        const playerItem = document.createElement("div");
        playerItem.className = "waiting-player-item";
        playerItem.innerHTML = `
          <div class="waiting-player-avatar">${player.avatarLetter || "?"}</div>
          <div class="waiting-player-name">${player.name || "プレイヤー"}</div>
        `;
        playersListEl.appendChild(playerItem);
      });
    }

    // 参加者数を更新
    if (playersCountEl) {
      playersCountEl.textContent = String(GameState.players.length || 0);
    }

    // ゲーム開始ボタンの有効/無効を切り替え
    if (startBtn) {
      const canStart = GameState.players.length >= 3 && GameState.players.length <= 8;
      startBtn.disabled = !canStart;
      if (canStart) {
        startBtn.textContent = `ゲーム開始 (${GameState.players.length}人)`;
      } else {
        startBtn.textContent = `ゲーム開始 (最低3人必要 / 現在${GameState.players.length}人)`;
      }
    }
  }
}

export { renderAll, renderStatus, renderPlayers, renderWaitingScreen };

