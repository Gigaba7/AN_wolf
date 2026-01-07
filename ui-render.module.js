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
  updateControlPermissions();
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

  // 表示順：Firestoreで同期された playerOrder を最優先
  const order =
    (Array.isArray(GameState.playerOrder) && GameState.playerOrder.length
      ? GameState.playerOrder
      : typeof window !== "undefined" && Array.isArray(window.RoomInfo?.gameState?.playerOrder)
      ? window.RoomInfo.gameState.playerOrder
      : null) || null;

  const orderIndex = order ? new Map(order.map((id, idx) => [id, idx])) : null;
  const playersToRender = [...(GameState.players || [])];
  if (orderIndex) {
    playersToRender.sort((a, b) => {
      const ai = orderIndex.has(a.id) ? orderIndex.get(a.id) : 9999;
      const bi = orderIndex.has(b.id) ? orderIndex.get(b.id) : 9999;
      return ai - bi;
    });
  }

  // 現在プレイヤーは index ではなく id で特定（並べ替えに強くする）
  const currentId = order
    ? order[Math.max(0, Math.min(GameState.currentPlayerIndex, order.length - 1))]
    : GameState.players?.[GameState.currentPlayerIndex]?.id || null;

  const myId = typeof window !== "undefined" ? window.__uid : null;

  playersToRender.forEach((p) => {
    const card = document.createElement("div");
    card.className = "player-card";
    if (currentId && p.id === currentId) {
      card.classList.add("current");
    }

    const avatar = document.createElement("div");
    avatar.className = "player-avatar";
    avatar.textContent = p.avatarLetter || "?";

    const meta = document.createElement("div");
    meta.className = "player-meta";

    const name = document.createElement("div");
    name.className = "player-name";
    name.textContent = p.name || "プレイヤー";

    // 自分の名前を太字に
    const isMe = !!(myId && p.id === myId);
    if (isMe) {
      name.classList.add("player-name-self");
    }

    // 自分の役職のみ表示（他者は非表示）
    if (isMe && p.role) {
      const roleLabel =
        p.role === "doctor" ? "ドクター" : p.role === "wolf" ? "人狼" : "市民";
      const roleClass =
        p.role === "doctor"
          ? "role-doctor"
          : p.role === "wolf"
          ? "role-wolf"
          : "role-citizen";
      const roleTag = document.createElement("span");
      roleTag.className = `player-role-tag ${roleClass}`;
      roleTag.textContent = roleLabel;
      name.appendChild(roleTag);
    }

    card.appendChild(avatar);
    meta.appendChild(name);
    card.appendChild(meta);
    listEl.appendChild(card);
  });
}

function updateControlPermissions() {
  const myId = typeof window !== "undefined" ? window.__uid : null;
  const phase = typeof window !== "undefined" ? window.RoomInfo?.gameState?.phase : null;

  const btnSuccess = $("#btn-success");
  const btnFail = $("#btn-fail");
  const btnWolf = $("#btn-wolf-action");
  const btnDoc = $("#btn-doctor-punch");

  // 現在プレイヤーは playerOrder + currentPlayerIndex で決める（配列並び替えに強くする）
  const order =
    (Array.isArray(GameState.playerOrder) && GameState.playerOrder.length
      ? GameState.playerOrder
      : typeof window !== "undefined" && Array.isArray(window.RoomInfo?.gameState?.playerOrder)
      ? window.RoomInfo.gameState.playerOrder
      : null) || null;
  const currentPlayerId = order
    ? order[Math.max(0, Math.min(GameState.currentPlayerIndex, order.length - 1))]
    : GameState.players?.[GameState.currentPlayerIndex]?.id || null;
  const currentPlayer = currentPlayerId
    ? GameState.players.find((p) => p.id === currentPlayerId) || null
    : null;

  const isCurrent = !!(myId && currentPlayer?.id && currentPlayer.id === myId);
  const myRole = myId ? GameState.players.find((p) => p.id === myId)?.role : null;

  const inPlaying = phase === "playing";
  const hasPendingFailure = !!GameState.pendingFailure;
  const pendingForMe = !!(hasPendingFailure && myId && GameState.pendingFailure?.playerId === myId);

  // 成功/失敗は「プレイ中の現在プレイヤーのみ」
  // ただし失敗後は「神拳使用フェーズ」になるため、成功は無効・失敗は「失敗確定（神拳なし）」のみ可能
  if (btnSuccess) btnSuccess.disabled = !(inPlaying && isCurrent && !hasPendingFailure);
  if (btnFail) {
    btnFail.disabled = !(inPlaying && isCurrent && (!hasPendingFailure || pendingForMe));
    btnFail.textContent = hasPendingFailure ? "失敗確定（神拳なし）" : "失敗";
  }

  // 人狼妨害は人狼のみ（プレイ中）
  if (btnWolf) btnWolf.disabled = !(inPlaying && myRole === "wolf" && GameState.wolfActionsRemaining > 0);

  // ドクター神拳はドクターのみ（プレイ中・失敗保留あり・残数あり・ターン内未使用）
  if (btnDoc)
    btnDoc.disabled = !(
      inPlaying &&
      myRole === "doctor" &&
      hasPendingFailure &&
      GameState.doctorPunchAvailableThisTurn &&
      GameState.doctorPunchRemaining > 0
    );
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
      const phase = typeof window !== "undefined" ? window.RoomInfo?.gameState?.phase : null;
      const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
      const myId = typeof window !== "undefined" ? window.__uid : null;
      const isHost = !!(createdBy && myId && createdBy === myId);

      const canStartCount = GameState.players.length >= 3 && GameState.players.length <= 8;
      const canStartPhase = !phase || phase === "waiting";
      const canStart = isHost && canStartCount && canStartPhase;

      startBtn.disabled = !canStart;
      if (!isHost) {
        startBtn.textContent = "ゲーム開始（ホストのみ）";
      } else if (!canStartPhase) {
        startBtn.textContent = "ゲーム開始（進行中）";
      } else if (canStartCount) {
        startBtn.textContent = `ゲーム開始 (${GameState.players.length}人)`;
      } else {
        startBtn.textContent = `ゲーム開始 (最低3人必要 / 現在${GameState.players.length}人)`;
      }
    }
  }
}

export { renderAll, renderStatus, renderPlayers, renderWaitingScreen };

