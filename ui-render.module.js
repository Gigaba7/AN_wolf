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
  renderUnderVideoInfo();
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

    // ドクター神拳発動可否フラグ（ランプ表示）
    const doctorPlayer = GameState.players.find(p => p.role === "doctor");
    if (doctorPlayer && doctorPlayer.resources) {
      const available = doctorPlayer.resources.doctorPunchAvailableThisTurn !== false;
      if (doctorPunchEl) {
        // ランプ/マークが光る表示
        doctorPunchEl.innerHTML = available 
          ? '<span style="display: inline-block; width: 24px; height: 24px; border-radius: 50%; background: #8be6c3; box-shadow: 0 0 8px rgba(139, 230, 195, 0.8), 0 0 16px rgba(139, 230, 195, 0.4); animation: pulse 2s ease-in-out infinite;"></span>'
          : '<span style="display: inline-block; width: 24px; height: 24px; border-radius: 50%; background: #555; opacity: 0.5;"></span>';
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

  const inPlaying = phase === "playing";
  const subphase = typeof window !== "undefined" ? window.RoomInfo?.gameState?.subphase : null;

  if (isGM) {
    // GM：成功/失敗ボタン（ステージ選出後、結果待ちフェーズで有効）
    const canJudge = inPlaying && subphase === "await_result";
    if (btnSuccess) btnSuccess.disabled = !canJudge || !!GameState.pendingFailure;
    if (btnFail) {
      btnFail.disabled = !canJudge;
      // ドクター操作中は失敗ボタンのテキストを変更しない（常に「失敗」）
      btnFail.textContent = "失敗";
    }
    
    // GM：ステージ選出開始ボタン（ステージ未選出時のみ有効）
    const btnStageRoulette = $("#btn-open-stage-roulette");
    if (btnStageRoulette) {
      const currentStage = GameState.currentStage;
      const stageTurn = typeof window !== "undefined" ? window.RoomInfo?.gameState?.stageTurn : null;
      const turn = GameState.turn;
      // ステージが未選出、または現在のターンと異なるターンのステージの場合に有効
      const needsStageSelection = !currentStage || (stageTurn !== null && stageTurn !== turn);
      btnStageRoulette.disabled = !(inPlaying && needsStageSelection && (subphase === "gm_stage" || subphase === null));
    }
  } else {
    // 参加者：役職ボタンのみ（その役職のプレイヤーにのみ表示）
    const myRole = myId ? GameState.players.find((p) => p.id === myId)?.role : null;
    const hasPendingFailure = !!GameState.pendingFailure;
    const pendingForMe = !!(hasPendingFailure && myId && GameState.pendingFailure?.playerId === myId);

    // ドクター神拳：ドクターのみ表示（await_doctorフェーズで、pendingFailureが存在する場合）
    // ゲストUIでは画面中央のポップアップとして表示
    const doctorPunchModal = document.getElementById("doctor-punch-modal");
    const isAwaitDoctor = subphase === "await_doctor";
    const isDoctor = myRole === "doctor";
    const shouldShowDoctorPunch = isDoctor && isAwaitDoctor && hasPendingFailure;
    
    // 画面中央のポップアップを表示/非表示
    if (doctorPunchModal) {
      const canUsePunch = inPlaying &&
        isDoctor &&
        isAwaitDoctor &&
        hasPendingFailure &&
        GameState.doctorPunchAvailableThisTurn &&
        GameState.doctorPunchRemaining > 0;
      
      // 重複表示防止：既に表示されている場合は更新のみ
      const isModalVisible = !doctorPunchModal.classList.contains("hidden");
      
      if (shouldShowDoctorPunch) {
        // ポップアップを表示（既に表示されている場合は更新のみ）
        if (!isModalVisible) {
          doctorPunchModal.classList.remove("hidden");
        }
        
        // ボタンの有効/無効を設定
        const useBtn = document.getElementById("doctor-punch-modal-use");
        const skipBtn = document.getElementById("doctor-punch-modal-skip");
        if (useBtn) {
          useBtn.disabled = !canUsePunch;
        }
        if (skipBtn) {
          skipBtn.disabled = false; // 使用しないボタンは常に有効
        }
      } else {
        // ポップアップを非表示
        if (isModalVisible) {
          doctorPunchModal.classList.add("hidden");
        }
      }
    }
  }
}

function renderWaitingScreen(roomId) {
  const roomIdEl = $("#waiting-room-id");
  const playersListEl = $("#waiting-players-list");
  const playersCountEl = $("#waiting-players-count");
  const startBtn = $("#btn-start-game-from-waiting");
  const waitingTitle = $("#waiting-title");

  // GM名を取得してタイトルに表示
  if (waitingTitle) {
    const config = typeof window !== "undefined" ? window.RoomInfo?.config : null;
    const gmName = config?.gmName || config?.hostName || "GM";
    waitingTitle.textContent = `${gmName}のルーム`;
  }

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
      const resultReturnLobbyAcks = typeof window !== "undefined" ? window.RoomInfo?.gameState?.resultReturnLobbyAcks : {};

      const canStartCount = GameState.players.length >= 3 && GameState.players.length <= 8;
      const canStartPhase = !phase || phase === "waiting";
      
      // ロビーに戻る確認メカニズム：全員がロビーに戻るまでゲーム開始をブロック
      const playerIds = GameState.players.map(p => p.id);
      const hasResultReturnLobbyAcks = resultReturnLobbyAcks && Object.keys(resultReturnLobbyAcks).length > 0;
      const allReturnedLobby = !hasResultReturnLobbyAcks || playerIds.every((pid) => resultReturnLobbyAcks[pid] === true);
      const canStart = isHost && canStartCount && canStartPhase && allReturnedLobby;

      startBtn.disabled = !canStart;
      if (!isHost) {
        startBtn.textContent = "ゲーム開始（ホストのみ）";
      } else if (!canStartPhase) {
        startBtn.textContent = "ゲーム開始（進行中）";
      } else if (!allReturnedLobby && hasResultReturnLobbyAcks) {
        const returnedCount = playerIds.filter((pid) => resultReturnLobbyAcks[pid] === true).length;
        startBtn.textContent = `ゲーム開始（全員がロビーに戻るのを待っています ${returnedCount}/${playerIds.length}）`;
      } else if (canStartCount) {
        startBtn.textContent = `ゲーム開始 (${GameState.players.length}人)`;
      } else {
        startBtn.textContent = `ゲーム開始 (最低3人必要 / 現在${GameState.players.length}人)`;
      }
    }

    // ルール設定ボタンの表示/非表示（GMのみ表示）
    const rulesBtn = $("#btn-rules-settings");
    if (rulesBtn) {
      const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
      const myId = typeof window !== "undefined" ? window.__uid : null;
      const isHost = !!(createdBy && myId && createdBy === myId);
      rulesBtn.style.display = isHost ? "block" : "none";
    }
  }
}

// 妨害選択リストを描画（人狼のみ対象）
function renderWolfActionList() {
  const listEl = $("#wolf-action-list");
  const costDisplay = $("#wolf-cost-display");
  if (!listEl) return;

  const myId = typeof window !== "undefined" ? window.__uid : null;
  const myPlayer = myId ? GameState.players.find(p => p.id === myId) : null;
  
  // 人狼のコストを取得
  const wolfPlayer = GameState.players.find(p => p.role === "wolf");
  const currentCost = wolfPlayer?.resources?.wolfActionsRemaining || 100; // デフォルトは100

  if (costDisplay) costDisplay.textContent = String(currentCost);

  listEl.innerHTML = "";

  // 妨害データを取得（新形式優先、旧形式は後方互換性）
  const actions = Array.isArray(GameState.options.wolfActions) && GameState.options.wolfActions.length
    ? GameState.options.wolfActions
    : (Array.isArray(GameState.options.wolfActionTexts) ? GameState.options.wolfActionTexts.map(text => ({ text, cost: 1 })) : []);

  actions.forEach((action, index) => {
    const actionText = typeof action === "string" ? action : action.text;
    const actionCost = typeof action === "string" ? 1 : (action.cost || 1);
    const displayName = typeof action === "object" && action.displayName ? action.displayName : actionText;
    const oldName = typeof action === "object" && action.oldName ? action.oldName : null;
    const requiresRoulette = typeof action === "object" && action.requiresRoulette === true;
    const canAfford = currentCost >= actionCost;

    const item = document.createElement("div");
    item.className = "wolf-action-item";
    if (!canAfford) {
      item.classList.add("disabled");
    }
    item.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 4px; width: 100%;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span class="wolf-action-text">${displayName}</span>
          <span class="wolf-action-cost">Cost-${actionCost}</span>
        </div>
        ${oldName ? `<span style="opacity: 0.7; font-size: 12px; color: #a0a4ba;">${oldName}</span>` : ''}
      </div>
      <button class="btn primary small" ${!canAfford ? "disabled" : ""} data-action-index="${index}">
        発動
      </button>
    `;

    const btn = item.querySelector("button");
    if (btn && canAfford) {
      // 人狼のみが発動できる（このUIは人狼のみに表示される）
      btn.addEventListener("click", async () => {
        const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
        if (!roomId) return;
        
        try {
          const { activateWolfAction } = await import("./firebase-sync.js");
          // requiresRoulette が true の場合は、ルーレットオプションも渡す
          const rouletteOptions = typeof action === "object" && Array.isArray(action.rouletteOptions) ? action.rouletteOptions : null;

          // ターゲットバンは入力が必要
          if (actionText === "ターゲットバン") {
            // 既に入力UIがあれば二重に作らない
            if (!item.querySelector(".targetban-input")) {
              const box = document.createElement("div");
              box.className = "targetban-input";
              box.style.marginTop = "10px";
              box.style.display = "flex";
              box.style.flexDirection = "column";
              box.style.gap = "8px";

              const input = document.createElement("input");
              input.type = "text";
              input.placeholder = "使用不可にするオペレーター名（例: Exusiai）";
              input.style.width = "100%";
              input.style.padding = "8px";
              input.style.borderRadius = "8px";
              input.style.border = "1px solid rgba(255,255,255,0.2)";
              input.style.background = "rgba(5,7,18,0.8)";
              input.style.color = "#f5f5f7";
              input.style.fontSize = "13px";

              const row = document.createElement("div");
              row.style.display = "flex";
              row.style.gap = "8px";
              row.style.justifyContent = "flex-end";

              const confirmBtn = document.createElement("button");
              confirmBtn.className = "btn primary small";
              confirmBtn.textContent = "確定";

              const cancelBtn = document.createElement("button");
              cancelBtn.className = "btn ghost small";
              cancelBtn.textContent = "キャンセル";

              row.appendChild(cancelBtn);
              row.appendChild(confirmBtn);
              box.appendChild(input);
              box.appendChild(row);
              item.appendChild(box);
              input.focus();

              cancelBtn.addEventListener("click", () => {
                box.remove();
              });

              confirmBtn.addEventListener("click", async () => {
                const v = (input.value || "").trim();
                if (!v) {
                  alert("オペレーター名を入力してください。");
                  return;
                }
                try {
                  await activateWolfAction(roomId, actionText, actionCost, requiresRoulette, rouletteOptions, v);
                  const { closeModal } = await import("./ui-modals.js");
                  closeModal("wolf-action-select-modal");
                } catch (e) {
                  console.error("Failed to activate target ban:", e);
                  alert(e?.message || "ターゲットバンの確定に失敗しました。");
                }
              });
            }
            return;
          }

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
  
  // スキップボタンを追加（全プレイヤーがスキップできる）
  const skipItem = document.createElement("div");
  skipItem.className = "wolf-action-item";
  skipItem.style.marginTop = "10px";
  skipItem.innerHTML = `
    <button class="btn ghost wide" id="wolf-action-skip-btn">
      妨害を使用しない
    </button>
  `;
  listEl.appendChild(skipItem);
  
  // スキップボタンのイベントリスナー
  const skipBtn = skipItem.querySelector("#wolf-action-skip-btn");
  if (skipBtn) {
    skipBtn.addEventListener("click", async () => {
      const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
      if (!roomId) return;
      
      try {
        const { wolfDecision } = await import("./firebase-sync.js");
        await wolfDecision(roomId, "skip");
        const { closeModal } = await import("./ui-modals.js");
        closeModal("wolf-action-select-modal");
      } catch (e) {
        console.error("Failed to skip wolf action:", e);
        alert(e?.message || "妨害スキップに失敗しました。");
      }
    });
  }
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
    const roleLabel = myRole === "wolf" ? "レユニオン" : myRole === "doctor" ? "ドクター" : "オペレーター";
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

// ルールブック（全員が閲覧可能）に、ルーム設定の人狼妨害一覧を描画する
function renderRulebookWolfActions() {
  const tbody = document.getElementById("rulebook-wolf-actions-body");
  if (!tbody) return;

  const cfgActions =
    typeof window !== "undefined" ? window.RoomInfo?.config?.wolfActions : null;
  const actions = Array.isArray(cfgActions) && cfgActions.length
    ? cfgActions
    : (Array.isArray(GameState.options.wolfActions) ? GameState.options.wolfActions : []);

  tbody.innerHTML = "";

  // actions が空でも崩れないようにフォールバック行を出す
  if (!Array.isArray(actions) || actions.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="padding: 8px; color: #a0a4ba;" colspan="3">（妨害一覧を取得できませんでした）</td>
    `;
    tbody.appendChild(tr);
    return;
  }

  actions.forEach((a, idx) => {
    const name = (a?.displayName || a?.text || `妨害${idx + 1}`).toString();
    const cost = Number.isFinite(Number(a?.cost)) ? String(Math.floor(Number(a.cost))) : "-";
    // ルールブックの「効果」欄は旧仕様メモ（oldName）を優先し、無ければサブタイトルを短く表示
    const effect =
      (a?.oldName && String(a.oldName).trim()) ||
      (a?.announcementSubtitle && String(a.announcementSubtitle).trim()) ||
      "";

    const tr = document.createElement("tr");
    const border = idx === actions.length - 1 ? "" : 'border-bottom: 1px solid rgba(255,255,255,0.05);';
    tr.innerHTML = `
      <td style="padding: 8px; color: #a0a4ba; ${border}">${escapeHtml(name)}</td>
      <td style="padding: 8px; color: #ff6464; text-align: right; ${border}">${escapeHtml(cost)}</td>
      <td style="padding: 8px; color: #a0a4ba; ${border}">${escapeHtml(effect)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function escapeHtml(s) {
  const str = String(s ?? "");
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// GM画面：映像下エリアに「このターンの妨害内容」と「ルールテキスト」を表示
function renderUnderVideoInfo() {
  const el = document.querySelector(".play-video-under-space");
  if (!(el instanceof HTMLElement)) return;

  const roomInfo = typeof window !== "undefined" ? window.RoomInfo : null;
  const gs = roomInfo?.gameState || {};
  const cfg = roomInfo?.config || {};

  const currentWolf = gs?.currentWolfAction || null;
  const wolfText = typeof currentWolf?.text === "string" ? currentWolf.text : "";
  const wolfSub = typeof currentWolf?.announcementSubtitle === "string" ? currentWolf.announcementSubtitle : "";

  const ruleText = typeof cfg?.ruleText === "string" ? cfg.ruleText : (GameState.options.ruleText || "");

  el.innerHTML = `
    <div style="display:flex; gap:16px; height:100%; padding:14px 16px; box-sizing:border-box;">
      <div style="flex: 0 0 42%; min-width: 320px;">
        <div style="font-weight:700; font-size:16px; color:#f5f5f7; margin-bottom:8px;">このターンの妨害</div>
        <div style="font-size:14px; color:#d4d6e3; line-height:1.5; white-space:pre-wrap;">
          ${escapeHtml(wolfText || "（妨害なし）")}
        </div>
        ${wolfSub ? `<div style="margin-top:8px; font-size:12px; color:#a0a4ba; line-height:1.5; white-space:pre-wrap;">${escapeHtml(wolfSub)}</div>` : ""}
      </div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-weight:700; font-size:16px; color:#f5f5f7; margin-bottom:8px;">ルール</div>
        <div style="font-size:14px; color:#d4d6e3; line-height:1.6; white-space:pre-wrap; overflow:auto; max-height:100%;">
          ${escapeHtml(ruleText || "（ルールテキスト未設定：ルール設定で入力してください）")}
        </div>
      </div>
    </div>
  `;
}

export { renderAll, renderStatus, renderPlayers, renderWaitingScreen, renderWolfActionList, renderParticipantInfo, renderRulebookWolfActions, renderUnderVideoInfo };

