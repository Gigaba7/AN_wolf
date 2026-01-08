// Firebase同期処理
import { createRoom, joinRoom, subscribeToRoom, updateGameState, updatePlayerState, addLog, saveRandomResult, startGameAsHost as startGameAsHostDB, acknowledgeRoleReveal as acknowledgeRoleRevealDB, advanceToPlayingIfAllAcked as advanceToPlayingIfAllAckedDB, applySuccess as applySuccessDB, applyFail as applyFailDB, applyDoctorPunch as applyDoctorPunchDB, applyDoctorSkip as applyDoctorSkipDB, applyWolfAction as applyWolfActionDB, activateWolfAction as activateWolfActionDB, wolfDecision as wolfDecisionDB, resolveWolfAction as resolveWolfActionDB, resolveWolfActionRoulette as resolveWolfActionRouletteDB, clearWolfActionNotification as clearWolfActionNotificationDB, clearTurnResult as clearTurnResultDB, computeStartSubphase } from "./firebase-db.js";
import { signInAnonymously, getCurrentUserId, getCurrentUser } from "./firebase-auth.js";
import { firestore } from "./firebase-config.js";
import { doc, updateDoc, runTransaction } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
import { createRoomClient } from "./room-client.js";
import { $ } from "./game-state.js";

let currentRoomId = null;
let roomUnsubscribe = null;
let isSyncing = false;

// グローバル変数として公開（main.jsからアクセス可能にする）
if (typeof window !== 'undefined') {
  window.getCurrentRoomId = () => currentRoomId;
  window.setCurrentRoomId = (id) => { currentRoomId = id; };
}

// 同期処理を「デフォルト」にする RoomClient
const roomClient = createRoomClient({
  getRoomId: () => currentRoomId,
  setRoomId: (id) => {
    currentRoomId = id;
    if (typeof window !== "undefined" && window.setCurrentRoomId) {
      window.setCurrentRoomId(id);
    }
  },
  subscribe: (roomId, cb) => subscribeToRoom(roomId, cb),
  handlers: {
    success: (roomId, payload) => handleSuccessAction(payload, roomId),
    fail: (roomId, payload) => handleFailAction(payload, roomId),
    doctorPunch: (roomId, payload) => handleDoctorPunchAction(payload, roomId),
    wolfAction: (roomId, payload) => handleWolfActionAction(payload, roomId),
    stageRoulette: (roomId, payload) => handleStageRouletteAction(payload, roomId),
    updateConfig: (roomId, payload) => handleUpdateConfigAction(payload, roomId),
    clearWolfActionNotification: async (roomId, payload) => {
      await updateGameState(roomId, { "gameState.wolfActionNotification": null });
    },
    log: async (roomId, payload) => {
      const type = payload?.logType || "system";
      const message = payload?.logMessage || "";
      if (!message) return;
      await addLog(roomId, { type, message });
    },
  },
});

/**
 * ルーム作成とゲーム開始
 */
async function createRoomAndStartGame(players, config) {
  try {
    // 認証確認
    let currentUser = getCurrentUser();
    if (!currentUser) {
      console.log('Signing in anonymously...');
      await signInAnonymously();
      currentUser = getCurrentUser();
    }
    console.log('Current user:', currentUser?.uid);
    
    // ルーム作成
    console.log('Creating room...');
    /** @type {any} */
    const roomPayload = {
      hostName: config.hostName || 'ホスト',
      hostAvatarLetter: config.hostAvatarLetter,
      hostAvatarImage: config.hostAvatarImage,
      maxPlayers: config.maxPlayers || 8,
      stageMinChapter: config.stageMinChapter,
      stageMaxChapter: config.stageMaxChapter,
      wolfActionTexts: config.wolfActionTexts,
    };
    // 既に生成されたルームIDがある場合のみ渡す（undefinedを避ける）
    if (config.roomId) {
      roomPayload.roomId = config.roomId;
    }

    const roomId = await createRoom(roomPayload);
    console.log('Room created with ID:', roomId);
    
    currentRoomId = roomId;
    
    // GMは既にルーム作成時に追加済み
    // ゲーム状態を初期化（waiting状態のまま、全員揃うまで待機）
    await updateGameState(roomId, {
      'gameState.turn': 1,
      'gameState.phase': 'waiting', // 全員揃うまで待機
      'gameState.whiteStars': 0,
      'gameState.blackStars': 0,
      'gameState.currentPlayerIndex': 0,
    });
    
    // ルーム監視を開始
    startRoomSync(roomId);
    
    return roomId;
  } catch (error) {
    console.error('Failed to create room:', error);
    throw error;
  }
}

/**
 * ルーム参加と同期開始
 */
async function joinRoomAndSync(roomId, playerName, avatarImage = null, avatarLetter = null) {
  try {
    // 認証確認
    let currentUser = getCurrentUser();
    if (!currentUser) {
      await signInAnonymously();
      currentUser = getCurrentUser();
    }
    
    await joinRoom(roomId, playerName, avatarImage, avatarLetter);
    
    currentRoomId = roomId;
    if (typeof window !== 'undefined' && window.setCurrentRoomId) {
      window.setCurrentRoomId(roomId);
    }
    
    // ルーム監視を開始
    startRoomSync(roomId);
    
    return true;
  } catch (error) {
    console.error('Failed to join room:', error);
    throw error;
  }
}

/**
 * ルームデータのリアルタイム同期を開始
 */
function startRoomSync(roomId) {
  if (roomUnsubscribe) {
    roomUnsubscribe();
  }
  
  roomUnsubscribe = subscribeToRoom(roomId, (roomData) => {
    if (!roomData) {
      console.warn('Room data is null');
      return;
    }
    
    if (isSyncing) {
      return; // 同期中の重複実行を防ぐ
    }
    
    isSyncing = true;
    
    try {
      syncGameStateFromFirebase(roomData);
    } catch (error) {
      console.error('Sync error:', error);
    } finally {
      isSyncing = false;
    }
  });
}

/**
 * Firebaseから取得したデータをローカル状態に同期
 */
function syncGameStateFromFirebase(roomData) {
  // GameStateとrenderAllをグローバルから取得
  const GameState = typeof window !== 'undefined' ? window.GameState : null;
  const renderAll = typeof window !== 'undefined' ? window.renderAll : null;
  
  if (!GameState) {
    console.error('GameState is not available');
    return;
  }
  
  const gameState = roomData.gameState;
  const players = roomData.players;
  const userId = getCurrentUserId();
  const config = roomData.config || {};

  // ルーム情報をグローバルに保持（UI側のhost判定などに利用）
  if (typeof window !== 'undefined') {
    window.RoomInfo = {
      config: roomData.config || {},
      gameState: roomData.gameState || {},
      players: roomData.players || {},
    };
  }
  
  // ゲーム状態を同期
  GameState.phase = gameState.phase || "waiting";
  GameState.turn = gameState.turn || 1;
  GameState.whiteStars = gameState.whiteStars || 0;
  GameState.blackStars = gameState.blackStars || 0;
  GameState.currentPlayerIndex = gameState.currentPlayerIndex || 0;
  GameState.currentStage = gameState.currentStage;
  GameState.pendingFailure = gameState.pendingFailure || null;
  GameState.playerOrder = gameState.playerOrder || null;
  GameState.subphase = gameState.subphase || null;
  GameState.turnResult = gameState.turnResult || null;
  
  // ターン結果ポップアップを表示
  if (gameState.turnResult) {
    const resultModal = document.getElementById("turn-result-modal");
    const resultTitle = document.getElementById("turn-result-title");
    const resultMessage = document.getElementById("turn-result-message");
    if (resultModal && resultTitle && resultMessage) {
      if (gameState.turnResult === "success") {
        resultTitle.textContent = "ターン結果";
        resultMessage.textContent = "このターンは成功しました";
      } else if (gameState.turnResult === "failure") {
        resultTitle.textContent = "ターン結果";
        resultMessage.textContent = "このターンは失敗しました";
      }
      resultModal.classList.remove("hidden");
    }
  }
  
  // 妨害発動通知をクリア（表示後）
  if (gameState.wolfActionNotification) {
    // 通知は一度だけ表示するため、表示後にクリアする処理は別途実装
  }

  // ルーム共通オプションのみ同期（ステージ範囲・妨害内容）
  if (typeof config.stageMinChapter === "number") {
    GameState.options.stageMinChapter = config.stageMinChapter;
  }
  if (typeof config.stageMaxChapter === "number") {
    GameState.options.stageMaxChapter = config.stageMaxChapter;
  }
  if (Array.isArray(config.wolfActionTexts) && config.wolfActionTexts.length) {
    GameState.options.wolfActionTexts = config.wolfActionTexts;
  }
  
  // プレイヤー情報を同期
  let playersArr = Object.entries(players).map(([playerId, playerData]) => ({
    id: playerId,
    name: playerData.name,
    avatarLetter: playerData.avatarLetter || playerData.name?.[0] || '?',
    avatarImage: playerData.avatarImage || null,
    role: playerData.role,
    resources: playerData.resources || {},
  }));

  // プレイ順がある場合はその順に並べる
  if (Array.isArray(gameState.playerOrder) && gameState.playerOrder.length) {
    const orderIndex = new Map(gameState.playerOrder.map((id, idx) => [id, idx]));
    playersArr.sort((a, b) => {
      const ai = orderIndex.has(a.id) ? orderIndex.get(a.id) : 9999;
      const bi = orderIndex.has(b.id) ? orderIndex.get(b.id) : 9999;
      return ai - bi;
    });
  }

  GameState.players = playersArr;
  
  // 自分のリソース情報を同期
  if (players[userId]) {
    const myResources = players[userId].resources || {};
    GameState.wolfActionsRemaining = myResources.wolfActionsRemaining || 100;
    GameState.doctorPunchRemaining = myResources.doctorPunchRemaining || 5;
    GameState.doctorPunchAvailableThisTurn = myResources.doctorPunchAvailableThisTurn !== false;
  }
  
  // UIを更新
  if (renderAll && typeof renderAll === 'function') {
    renderAll();
  }

  // フェーズに応じたUI制御（モーダル表示/画面遷移）
  handlePhaseUI(roomData);
  
  // ログを同期
  if (roomData.logs && roomData.logs.length > 0) {
    syncLogs(roomData.logs);
  }
}

function handlePhaseUI(roomData) {
  const gameState = roomData.gameState || {};
  const phase = gameState.phase;
  const userId = getCurrentUserId();

  // revealing: GMは全員の役職を周知、参加者は自分の役職のみ表示
  if (phase === 'revealing') {
    const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
    const myId = typeof window !== "undefined" ? window.__uid : null;
    const isGM = !!(createdBy && myId && createdBy === myId);

    // 全員（GM含む）：自分の役職を確認
    const acks = gameState.revealAcks || {};
    const alreadyAcked = userId ? acks[userId] === true : false;

    const myRole = roomData.players?.[userId]?.role || null;
    if (myRole) {
      const modal = document.getElementById("self-role-modal");
      const roleText = document.getElementById("self-role-text");
      const okBtn = document.getElementById("self-role-ok");
      const waitText = document.getElementById("self-role-waiting");

      if (roleText) {
        roleText.textContent =
          myRole === "wolf" ? "人狼（レユニオン）" : myRole === "doctor" ? "ドクター" : "市民";
      }

      if (alreadyAcked) {
        okBtn?.setAttribute("disabled", "true");
        okBtn && (okBtn.textContent = "OK済み");
        waitText && (waitText.textContent = "開始待機中…（全員のOKを待っています）");
        waitText?.classList.remove("hidden");
      } else {
        okBtn?.removeAttribute("disabled");
        okBtn && (okBtn.textContent = "OK");
        waitText?.classList.add("hidden");
      }

      modal?.classList.remove("hidden");
    }
    
    // GM：全員の役職を周知（OBSアナウンス→役職一覧）
    if (isGM) {
      const announcementModal = document.getElementById("gm-announcement-modal");
      const rolesModal = document.getElementById("gm-roles-modal");
      
      // 初回のみアナウンス表示（一度表示したら再表示しない）
      if (announcementModal && !announcementModal.dataset.shown) {
        // アナウンスモーダルを表示
        announcementModal.dataset.shown = "true";
        announcementModal.classList.remove("hidden");
        // 役職一覧モーダルは閉じる
        if (rolesModal) rolesModal.classList.add("hidden");
      }
      // アナウンスが閉じられて、役職一覧がまだ表示されていない場合は何もしない
      // （gm-announcement-ok のクリックで showGMRolesModal が呼ばれる）
    }

    // 全員OKならGMがplayingに進める（ただし、GMが役職一覧を確認した後）
    // 注意：役職一覧OKボタン（gm-roles-ok）でadvanceToPlayingIfAllAckedを呼ぶため、ここでは呼ばない
  }

  // playing: 待機画面→GM/参加者画面へ分岐
  if (phase === 'playing') {
    // role modalを閉じる
    document.getElementById("self-role-modal")?.classList.add("hidden");

    const waiting = document.getElementById("waiting-screen");
    const main = document.getElementById("main-screen");
    const participant = document.getElementById("participant-screen");
    
    const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
    const myId = typeof window !== "undefined" ? window.__uid : null;
    const isGM = !!(createdBy && myId && createdBy === myId);

    if (waiting?.classList.contains("active")) {
      waiting.classList.remove("active");
      if (isGM) {
        main?.classList.add("active");
      } else {
        participant?.classList.add("active");
      }
      // 画面切替直後に描画（初回はここで描画しないと待機画面分岐でreturnしてしまう）
      const renderAll = typeof window !== "undefined" ? window.renderAll : null;
      if (renderAll && typeof renderAll === "function") {
        renderAll();
      }
    }

    // GM：人狼妨害の選出リクエストをチェック
    if (isGM) {
      checkWolfActionRequest(roomData);
      
      // GM画面：サブフェーズに応じた操作中ポップアップを表示
      const subphase = gameState.subphase;
      const wolfOperationModal = document.getElementById("gm-wolf-operation-modal");
      const doctorOperationModal = document.getElementById("gm-doctor-operation-modal");
      
      if (subphase === "wolf_decision") {
        // 人狼が操作中
        if (wolfOperationModal) {
          wolfOperationModal.classList.remove("hidden");
        }
        if (doctorOperationModal) {
          doctorOperationModal.classList.add("hidden");
        }
      } else if (subphase === "await_doctor") {
        // ドクターが操作中
        if (doctorOperationModal) {
          doctorOperationModal.classList.remove("hidden");
        }
        if (wolfOperationModal) {
          wolfOperationModal.classList.add("hidden");
        }
      } else {
        // 操作中ではない
        if (wolfOperationModal) {
          wolfOperationModal.classList.add("hidden");
        }
        if (doctorOperationModal) {
          doctorOperationModal.classList.add("hidden");
        }
      }
    } else {
      // 参加者：人狼妨害の手番開始フェーズをチェック
      checkWolfDecisionPhase(roomData);
    }
    
    // 全員：サブフェーズに応じたUI更新
    const renderAll = typeof window !== "undefined" ? window.renderAll : null;
    if (renderAll && typeof renderAll === "function") {
      renderAll();
    }
  }
}

let lastStageModalTurn = null;
let lastStageRequestedTurn = null;

// 参加者：人狼妨害の手番開始フェーズをチェック（人狼のみ対象）
function checkWolfDecisionPhase(roomData) {
  const gameState = roomData.gameState || {};
  const subphase = gameState.subphase;
  const userId = getCurrentUserId();
  const players = roomData.players || {};
  
  if (subphase === "wolf_decision") {
    const wolfDecisionPlayerId = gameState.wolfDecisionPlayerId || null;
    
    // 人狼のみに対して妨害選択UIを表示
    if (wolfDecisionPlayerId === userId) {
      const myPlayer = players[userId];
      if (myPlayer && myPlayer.role === "wolf") {
        const modal = document.getElementById("wolf-action-select-modal");
        if (modal && modal.classList.contains("hidden")) {
          modal.classList.remove("hidden");
          // 妨害リストを描画
          const { renderWolfActionList } = typeof window !== "undefined" ? window : {};
          if (renderWolfActionList && typeof renderWolfActionList === "function") {
            renderWolfActionList();
          } else {
            // モジュールから動的インポート
            import("./ui-render.module.js").then((module) => {
              if (module.renderWolfActionList) {
                module.renderWolfActionList();
              }
            });
          }
        }
      }
    }
  } else {
    // フェーズが変わったらモーダルを閉じる
    const modal = document.getElementById("wolf-action-select-modal");
    if (modal && !modal.classList.contains("hidden")) {
      modal.classList.add("hidden");
    }
  }
}

// GM：人狼妨害の発動通知をチェック
let lastNotificationTimestamp = null;
function checkWolfActionRequest(roomData) {
  const gameState = roomData.gameState || {};
  const notification = gameState.wolfActionNotification || null;
  const request = gameState.wolfActionRequest || null;
  const subphase = gameState.subphase;
  
  // ルーレットが必要な妨害の場合（wolf_resolving フェーズ）
  if (subphase === "wolf_resolving" && request && request.rouletteOptions) {
    const modal = document.getElementById("job-roulette-modal");
    if (modal && modal.classList.contains("hidden")) {
      modal.classList.remove("hidden");
      // ルーレットアイテムを設定
      const itemsEl = document.getElementById("job-roulette-items");
      if (itemsEl) {
        itemsEl.innerHTML = "";
        request.rouletteOptions.forEach((option) => {
          const item = document.createElement("div");
          item.className = "roulette-item";
          item.textContent = option;
          itemsEl.appendChild(item);
        });
      }
    }
    return;
  }
  
  // 通常の妨害発動通知
  if (notification && notification.timestamp && notification.timestamp !== lastNotificationTimestamp) {
    lastNotificationTimestamp = notification.timestamp;
    // GM画面に妨害発動通知ポップアップを表示
    const modal = document.getElementById("gm-wolf-action-notification-modal");
    const textEl = document.getElementById("gm-wolf-action-text");
    if (modal && textEl) {
      textEl.textContent = `妨害『${notification.text}』が発動されました`;
      if (modal.classList.contains("hidden")) {
        modal.classList.remove("hidden");
      }
    }
  }
  
  // フェーズが変わったら職業ルーレットモーダルを閉じる
  if (subphase !== "wolf_resolving") {
    const jobModal = document.getElementById("job-roulette-modal");
    if (jobModal && !jobModal.classList.contains("hidden")) {
      jobModal.classList.add("hidden");
    }
  }
}

// GM：全員の役職一覧を表示
function showGMRolesModal(roomData) {
  const modal = document.getElementById("gm-roles-modal");
  const listEl = document.getElementById("gm-roles-list");
  if (!modal || !listEl) return;

  const players = roomData.players || {};
  listEl.innerHTML = "";

  Object.entries(players).forEach(([playerId, playerData]) => {
    const role = playerData.role || null;
    if (!role) return;

    const roleLabel =
      role === "wolf" ? "人狼（レユニオン）" : role === "doctor" ? "ドクター" : "市民";
    const roleClass =
      role === "doctor"
        ? "role-doctor"
        : role === "wolf"
        ? "role-wolf"
        : "role-citizen";

    const item = document.createElement("div");
    item.className = "role-confirmation-item";
    item.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <span style="font-weight: 500;">${playerData.name || "プレイヤー"}</span>
        <span class="player-role-tag ${roleClass}">${roleLabel}</span>
      </div>
    `;
    listEl.appendChild(item);
  });

  modal.classList.remove("hidden");
}

function setStageRoulettePendingLog(visible) {
  const logListEl = $("#log-list");
  if (!logListEl) return;

  const existing = logListEl.querySelector('[data-transient="stage-roulette"]');
  if (visible) {
    if (existing) return;
    const item = document.createElement("div");
    item.className = "log-item log-system";
    item.dataset.transient = "stage-roulette";
    item.textContent = `[${new Date().toLocaleTimeString()}] ステージ抽選中……`;
    logListEl.appendChild(item);
    logListEl.scrollTop = logListEl.scrollHeight;
  } else {
    existing?.remove();
  }
}

function maybeAutoStageRoulette(roomData) {
  const gameState = roomData.gameState || {};
  const turn = Number(gameState.turn || 1);
  const currentStage = gameState.currentStage || null;
  const stageTurn = gameState.stageTurn ?? null;
  const subphase = gameState.subphase;

  const modal = document.getElementById("stage-roulette-modal");
  const subtitle = modal?.querySelector(".modal-subtitle");
  const items = document.getElementById("stage-roulette-items");

  const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
  const myId = typeof window !== "undefined" ? window.__uid : null;
  const isGM = !!(createdBy && myId && createdBy === myId);

  // ターン開始時（currentStageがnull、またはstageTurnが現在のターンと異なる）に自動抽選
  const needsStageSelection = !currentStage || (stageTurn !== null && stageTurn !== turn);
  
  // ターンの初め（gm_stage フェーズ）でステージ未選出の場合、自動でルーレット開始
  // 人狼の妨害フェーズが終わった後（wolf_decision → gm_stage）にも実行される
  if (needsStageSelection && subphase === "gm_stage" && lastStageModalTurn !== turn) {
    lastStageModalTurn = turn;
    subtitle && (subtitle.textContent = "ステージ抽選中……");
    if (items) items.innerHTML = "";
    modal?.classList.remove("hidden");
    setStageRoulettePendingLog(true);

    // GMだけが1回だけ抽選を実行（自動）
    if (isGM && lastStageRequestedTurn !== turn) {
      lastStageRequestedTurn = turn;
      // 動的インポートで startStageRoulette を呼び出す
      import("./game-roulette.js").then((module) => {
        if (module.startStageRoulette) {
          module.startStageRoulette();
        }
      }).catch((error) => {
        console.error("Failed to import game-roulette:", error);
      });
    }
  }

  // そのターンの抽選が完了したら「抽選中……」表示は消す（結果は上部ステータスに反映）
  const resolvedThisTurn = stageTurn === turn && !!currentStage;
  if (resolvedThisTurn) {
    setStageRoulettePendingLog(false);

    // ステージ決定：結果を表示して自動で閉じる
    if (lastStageModalTurn === turn && modal && !modal.classList.contains("hidden")) {
      subtitle && (subtitle.textContent = `ステージ決定: ${currentStage}`);
      if (items) {
        items.innerHTML = "";
        const el = document.createElement("div");
        el.className = "roulette-item selected";
        el.textContent = currentStage;
        items.appendChild(el);
      }
      setTimeout(() => {
        modal.classList.add("hidden");
      }, 900);
    }
  }
}

/**
 * ホストのみ：ゲーム開始（役職割当→revealへ）
 */
async function startGameAsHost(roomId) {
  await startGameAsHostDB(roomId);
}

/**
 * 自分の役職確認OK
 */
async function acknowledgeRoleReveal(roomId) {
  await acknowledgeRoleRevealDB(roomId);
}

/**
 * ローカルの変更をFirebaseに送信
 */
async function syncToFirebase(action, data) {
  try {
    await roomClient.dispatch(action, data || {});
  } catch (error) {
    console.error('Failed to sync to Firebase:', error);
    throw error;
  }
}

/**
 * 成功アクションの処理
 */
async function handleSuccessAction(data, roomId) {
  const userId = getCurrentUserId();
  await applySuccessDB(roomId);
  const name = data?.playerName || "プレイヤー";
  await addLog(roomId, { type: "success", message: `${name} がステージ攻略に成功しました。`, playerId: userId });
}

/**
 * 失敗アクションの処理
 */
async function handleFailAction(data, roomId) {
  const userId = getCurrentUserId();
  await applyFailDB(roomId);
  const name = data?.playerName || "プレイヤー";
  const isConfirm = data?.isConfirm === true;
  const msg = isConfirm
    ? `${name} の失敗が確定しました。（神拳なし）`
    : `${name} の失敗が入力されました。${"ドクターは神拳で救済できます。"} `;
  await addLog(roomId, { type: "fail", message: msg.trim(), playerId: userId });
}

/**
 * ドクター神拳アクションの処理
 */
async function handleDoctorPunchAction(data, roomId) {
  const userId = getCurrentUserId();
  await applyDoctorPunchDB(roomId);
  const target = data?.targetPlayerName || data?.playerName || "プレイヤー";
  await addLog(roomId, { type: "doctorPunch", message: `ドクター神拳発動！ ${target} の失敗はなかったことになりました。`, playerId: userId });
}

/**
 * 人狼妨害アクションの処理
 */
async function handleWolfActionAction(data, roomId) {
  const userId = getCurrentUserId();
  await applyWolfActionDB(roomId);
  // 乱数結果を保存（既にクライアント側で選択済み）
  await saveRandomResult(roomId, `wolfAction_${Date.now()}`, { action: data.action, timestamp: Date.now() });
  await addLog(roomId, { type: "wolfAction", message: `人狼妨害: ${data.action} が発動されました。`, playerId: userId });
}

/**
 * 次のプレイヤーアクションの処理
 */
// nextPlayer は削除（自動進行）

/**
 * ステージルーレットアクションの処理
 */
async function handleStageRouletteAction(data, roomId) {
  const GameState = typeof window !== 'undefined' ? window.GameState : null;
  if (!GameState) return;
  
  const stage = data?.stageName || data?.stage || null;
  if (!stage) return;

  // 乱数結果を保存（既にクライアント側で選択済み）
  await saveRandomResult(roomId, `stage_${GameState.turn}`, {
    stage,
    turn: GameState.turn,
    timestamp: Date.now(),
  });
  
  // ステージ選出完了後、最初のプレイヤーの手番開始時に妨害フェーズを設定
  const roomRef = doc(firestore, "rooms", roomId);
  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();
    
    const playersObj = data?.players || {};
    const order = Array.isArray(data?.gameState?.playerOrder) && data.gameState.playerOrder.length
      ? data.gameState.playerOrder
      : Object.keys(playersObj);
    const currentPlayerIndex = Number(data?.gameState?.currentPlayerIndex || 0);
    
    // 現在のプレイヤーの手番開始時に妨害フェーズを設定
    const startPhase = computeStartSubphase(playersObj, order, currentPlayerIndex);
    
    // 人狼の妨害フェーズの場合は wolf_decision、それ以外は await_result（ステージ選出完了後）
    const nextSubphase = startPhase.subphase === "wolf_decision" ? "wolf_decision" : "await_result";
    
    tx.update(roomRef, {
      'gameState.currentStage': stage,
      'gameState.stageTurn': GameState.turn,
      'gameState.subphase': nextSubphase,
      'gameState.wolfDecisionPlayerId': startPhase.wolfDecisionPlayerId,
      'gameState.wolfActionRequest': null,
    });
  });
  
  await addLog(roomId, {
    type: 'stage',
    message: `ターン${GameState.turn}のステージ: ${stage}`,
  });
}

/**
 * ルーム共通設定更新（ホストのみ）
 * - 共有: stageMinChapter / stageMaxChapter / wolfActionTexts
 * - 非共有: それ以外（クライアントローカル）
 */
async function handleClearTurnResultAction(data, roomId) {
  await clearTurnResultDB(roomId);
}

async function handleUpdateConfigAction(data, roomId) {
  const userId = getCurrentUserId();
  if (!userId) return;

  const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
  if (!createdBy || createdBy !== userId) {
    throw new Error("Only host can update room config");
  }

  const min = Number(data?.stageMinChapter);
  const max = Number(data?.stageMaxChapter);
  const wolfActionTexts = Array.isArray(data?.wolfActionTexts) ? data.wolfActionTexts : null;

  /** @type {Record<string, any>} */
  const updates = {};
  if (Number.isFinite(min)) updates["config.stageMinChapter"] = min;
  if (Number.isFinite(max)) updates["config.stageMaxChapter"] = max;
  if (wolfActionTexts && wolfActionTexts.length) updates["config.wolfActionTexts"] = wolfActionTexts;

  if (!Object.keys(updates).length) return;

  await updateDoc(doc(firestore, "rooms", roomId), updates);
  await addLog(roomId, { type: "system", message: "オプション（ステージ範囲/妨害内容）を更新しました。", playerId: userId });
}

/**
 * ログを同期
 */
function syncLogs(logs) {
  const logListEl = $("#log-list");
  if (!logListEl) return;
  
  // 最新のログのみ表示（既存のログは保持）
  // transient（ローカル一時表示）を除外して差分同期する
  const existingLogs = Array.from(logListEl.children).filter((el) => !el.dataset?.transient).length;
  const newLogs = logs.slice(existingLogs);

  newLogs.forEach((log) => {
    appendLogToUI(log);
  });
}

function appendLogToUI(log) {
  const logListEl = $("#log-list");
  if (!logListEl) return;
  const item = document.createElement("div");
  item.className = `log-item log-${log.type || "system"}`;

  const ts = log.timestamp;
  const time =
    typeof ts === "number"
      ? new Date(ts).toLocaleTimeString()
      : ts?.toDate
      ? new Date(ts.toDate()).toLocaleTimeString()
      : new Date().toLocaleTimeString();

  item.textContent = `[${time}] ${log.message || ""}`;
  logListEl.appendChild(item);
  logListEl.scrollTop = logListEl.scrollHeight;
}

// assignRoles関数はmain.jsで定義されているため、ここでは使用しない

/**
 * ルーム同期を停止
 */
function stopRoomSync() {
  if (roomUnsubscribe) {
    roomUnsubscribe();
    roomUnsubscribe = null;
  }
  currentRoomId = null;
}

// エクスポート
// 人狼妨害の決定と解決をエクスポート
async function wolfDecision(roomId, decision) {
  return await wolfDecisionDB(roomId, decision);
}

async function resolveWolfAction(roomId, actionText) {
  return await resolveWolfActionDB(roomId, actionText);
}

async function resolveWolfActionRoulette(roomId, selectedJob) {
  return await resolveWolfActionRouletteDB(roomId, selectedJob);
}

async function activateWolfAction(roomId, actionText, actionCost, requiresRoulette = false, rouletteOptions = null) {
  return await activateWolfActionDB(roomId, actionText, actionCost, requiresRoulette, rouletteOptions);
}

export { createRoomAndStartGame, joinRoomAndSync, syncToFirebase, stopRoomSync, startGameAsHost, acknowledgeRoleReveal, advanceToPlayingIfAllAckedDB, wolfDecision, resolveWolfAction, resolveWolfActionRoulette, activateWolfAction, showGMRolesModal, applyDoctorSkipDB };

// 新しいデフォルト同期API（チャット追加もここにぶら下げる想定）
export { roomClient };
