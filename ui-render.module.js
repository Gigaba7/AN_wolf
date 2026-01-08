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

  // 参加者画面の場合は参加者情報も更新
  const participantScreen = $("#participant-screen");
  if (participantScreen && participantScreen.classList.contains("active")) {
    renderParticipantInfo();
  }

  renderStatus();
  renderPlayers();
  updateControlPermissions();
}

// firebase-sync.js が最初の onSnapshot で UI 更新を呼ぶ前に参照できるように、
// モジュール評価時点でも公開しておく
if (typeof window !== "undefined") {
  window.renderAll = renderAll;
  window.renderWolfActionList = renderWolfActionList;
}

function renderStatus() {
  const turnEl = $("#status-turn");
  const starsEl = $("#status-stars");
  const stageEl = $("#status-stage");
  const wolfCostEl = $("#status-wolf-cost");
  const wolfCostItem = $("#status-wolf-cost-item");
  const doctorPunchEl = $("#status-doctor-punch");
  const doctorPunchItem = $("#status-doctor-punch-item");

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

  if (stageEl) {
    stageEl.textContent = GameState.currentStage || "未選出";
  }

  // GM画面：妨害コスト表示
  const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
  const myId = typeof window !== "undefined" ? window.__uid : null;
  const isGM = !!(createdBy && myId && createdBy === myId);
  
  if (isGM) {
    // 人狼プレイヤーを探してコストを表示（残数のみ）
    const wolfPlayer = GameState.players.find(p => p.role === "wolf");
    if (wolfPlayer && wolfPlayer.resources) {
      const cost = wolfPlayer.resources.wolfActionsRemaining || 100; // デフォルトは100
      if (wolfCostEl) {
        wolfCostEl.textContent = String(cost);
      }
      if (wolfCostItem) {
        wolfCostItem.style.display = "flex";
      }
    } else {
      if (wolfCostItem) {
        wolfCostItem.style.display = "none";
      }
    }

    // ドクター神拳発動可否フラグ
    const doctorPlayer = GameState.players.find(p => p.role === "doctor");
    if (doctorPlayer && doctorPlayer.resources) {
      const available = doctorPlayer.resources.doctorPunchAvailableThisTurn !== false;
      if (doctorPunchEl) {
        doctorPunchEl.textContent = available ? "true" : "false";
      }
      if (doctorPunchItem) {
        doctorPunchItem.style.display = "flex";
      }
    } else {
      if (doctorPunchItem) {
        doctorPunchItem.style.display = "none";
      }
    }
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
    avatar.innerHTML = "";
    if (p.avatarImage) {
      const img = document.createElement("img");
      img.className = "player-avatar-img";
      img.src = p.avatarImage;
      img.alt = "";
      avatar.appendChild(img);
    } else {
      const span = document.createElement("span");
      span.textContent = p.avatarLetter || "?";
      avatar.appendChild(span);
    }

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

    // GM画面のプレイヤー表示では役職タグは表示しない

    card.appendChild(avatar);
    meta.appendChild(name);
    card.appendChild(meta);
    listEl.appendChild(card);
  });
}

function updateControlPermissions() {
  const myId = typeof window !== "undefined" ? window.__uid : null;
  const phase = typeof window !== "undefined" ? window.RoomInfo?.gameState?.phase : null;
  const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
  const isGM = !!(createdBy && myId && createdBy === myId);

  // GM画面のボタン（成功/失敗のみ）
  const btnSuccess = $("#btn-success");
  const btnFail = $("#btn-fail");

  // 参加者画面のボタン（役職ボタンのみ）
  const btnWolf = $("#btn-wolf-action");
  const btnDoc = $("#btn-doctor-punch");

  const inPlaying = phase === "playing";
  const subphase = typeof window !== "undefined" ? window.RoomInfo?.gameState?.subphase : null;

  if (isGM) {
    // GM：成功/失敗ボタンのみ（ステージ選出後、結果待ちフェーズで有効）
    const canJudge = inPlaying && subphase === "await_result";
    if (btnSuccess) btnSuccess.disabled = !canJudge || !!GameState.pendingFailure;
    if (btnFail) {
      btnFail.disabled = !canJudge;
      btnFail.textContent = GameState.pendingFailure ? "失敗確定（神拳なし）" : "失敗";
    }
  } else {
    // 参加者：役職ボタンのみ
    const myRole = myId ? GameState.players.find((p) => p.id === myId)?.role : null;
    const hasPendingFailure = !!GameState.pendingFailure;
    const pendingForMe = !!(hasPendingFailure && myId && GameState.pendingFailure?.playerId === myId);

    // 人狼妨害：手番開始時の妨害フェーズ（wolf_decision）で有効、かつコストが1以上
    if (btnWolf) {
      const myPlayer = myId ? GameState.players.find((p) => p.id === myId) : null;
      const currentCost = myPlayer?.resources?.wolfActionsRemaining || 0;
      const canUseWolf = inPlaying && subphase === "wolf_decision" && myRole === "wolf" && currentCost > 0;
      btnWolf.disabled = !canUseWolf;
    }

    // ドクター神拳：失敗保留時のみ有効
    if (btnDoc) {
      btnDoc.disabled = !(
        inPlaying &&
        myRole === "doctor" &&
        hasPendingFailure &&
        pendingForMe &&
        GameState.doctorPunchAvailableThisTurn &&
        GameState.doctorPunchRemaining > 0
      );
    }
  }
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

        const av = document.createElement("div");
        av.className = "waiting-player-avatar";
        if (player.avatarImage) {
          const img = document.createElement("img");
          img.src = player.avatarImage;
          img.alt = "";
          av.appendChild(img);
        } else {
          av.textContent = player.avatarLetter || "?";
        }

        const nm = document.createElement("div");
        nm.className = "waiting-player-name";
        nm.textContent = player.name || "プレイヤー";

        playerItem.appendChild(av);
        playerItem.appendChild(nm);
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

// 妨害選択リストを描画（人狼用）
function renderWolfActionList() {
  const listEl = $("#wolf-action-list");
  const costDisplay = $("#wolf-cost-display");
  if (!listEl) return;

  const myId = typeof window !== "undefined" ? window.__uid : null;
  const myPlayer = myId ? GameState.players.find(p => p.id === myId) : null;
  const currentCost = myPlayer?.resources?.wolfActionsRemaining || 100; // デフォルトは100

  if (costDisplay) costDisplay.textContent = String(currentCost);

  listEl.innerHTML = "";

  // 妨害データを取得（新形式優先、旧形式は後方互換性）
  const actions = Array.isArray(GameState.options.wolfActions) && GameState.options.wolfActions.length
    ? GameState.options.wolfActions
    : (Array.isArray(GameState.options.wolfActionTexts) ? GameState.options.wolfActionTexts.map(text => ({ text, cost: 1 })) : []);

  actions.forEach((action, index) => {
    const actionText = typeof action === "string" ? action : action.text;
    const actionCost = typeof action === "string" ? 1 : (action.cost || 1);
    const requiresRoulette = typeof action === "object" && action.requiresRoulette === true;
    const canAfford = currentCost >= actionCost;

    const item = document.createElement("div");
    item.className = "wolf-action-item";
    if (!canAfford) {
      item.classList.add("disabled");
    }
    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
        <span class="wolf-action-text">${actionText}</span>
        <span class="wolf-action-cost">Cost: ${actionCost}</span>
      </div>
      <button class="btn primary small" ${!canAfford ? "disabled" : ""} data-action-index="${index}">
        発動
      </button>
    `;

    const btn = item.querySelector("button");
    if (btn && canAfford) {
      btn.addEventListener("click", async () => {
        const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
        if (!roomId) return;
        
        try {
          const { activateWolfAction } = await import("./firebase-sync.js");
          // requiresRoulette が true の場合は、ルーレットオプションも渡す
          const rouletteOptions = typeof action === "object" && Array.isArray(action.rouletteOptions) ? action.rouletteOptions : null;
          await activateWolfAction(roomId, actionText, actionCost, requiresRoulette, rouletteOptions);
          const { closeModal } = await import("./ui-modals.js");
          closeModal("wolf-action-select-modal");
        } catch (e) {
          console.error("Failed to activate wolf action:", e);
          alert(e?.message || "妨害発動に失敗しました。");
        }
      });
    }

    listEl.appendChild(item);
  });
}

// 参加者画面の役職・コスト表示を更新
function renderParticipantInfo() {
  const myId = typeof window !== "undefined" ? window.__uid : null;
  const myPlayer = myId ? GameState.players.find(p => p.id === myId) : null;
  const myRole = myPlayer?.role || null;

  // 役職表示
  const roleDisplay = $("#participant-role-display");
  const roleText = $("#participant-role-text");
  if (roleDisplay && roleText && myRole) {
    const roleLabel = myRole === "wolf" ? "人狼（レユニオン）" : myRole === "doctor" ? "ドクター" : "市民";
    roleText.textContent = roleLabel;
    roleDisplay.style.display = "block";
  } else if (roleDisplay) {
    roleDisplay.style.display = "none";
  }

  // コスト表示（人狼のみ、残数のみ）
  const costDisplay = $("#participant-cost-display");
  const costValue = $("#participant-cost-value");
  if (costDisplay && costValue) {
    if (myRole === "wolf" && myPlayer?.resources) {
      const cost = myPlayer.resources.wolfActionsRemaining || 100; // デフォルトは100
      costValue.textContent = String(cost);
      costDisplay.style.display = "block";
    } else {
      costDisplay.style.display = "none";
    }
  }
}

export { renderAll, renderStatus, renderPlayers, renderWaitingScreen, renderWolfActionList, renderParticipantInfo };

