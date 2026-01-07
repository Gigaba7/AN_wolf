// Firebase同期処理
import { createRoom, joinRoom, subscribeToRoom, updateGameState, updatePlayerState, addLog, saveRandomResult, startGameAsHost as startGameAsHostDB, acknowledgeRoleReveal as acknowledgeRoleRevealDB, advanceToPlayingIfAllAcked as advanceToPlayingIfAllAckedDB, applySuccess as applySuccessDB, applyFail as applyFailDB, applyDoctorPunch as applyDoctorPunchDB, applyWolfAction as applyWolfActionDB } from "./firebase-db.js";
import { signInAnonymously, getCurrentUserId, getCurrentUser } from "./firebase-auth.js";
import { firestore } from "./firebase-config.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
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
async function joinRoomAndSync(roomId, playerName) {
  try {
    // 認証確認
    let currentUser = getCurrentUser();
    if (!currentUser) {
      await signInAnonymously();
      currentUser = getCurrentUser();
    }
    
    // ルーム参加
    await joinRoom(roomId, playerName);
    
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
    avatarLetter: playerData.name[0] || '?',
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
    GameState.wolfActionsRemaining = myResources.wolfActionsRemaining || 5;
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

  // revealing: 自分の役職を表示し、OKを待つ
  if (phase === 'revealing') {
    const acks = gameState.revealAcks || {};
    const alreadyAcked = userId ? acks[userId] === true : false;

    // 自分の役職
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

    // 全員OKならホストがplayingに進める（ホスト以外はトランザクションを叩かない）
    const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
    const myId = typeof window !== "undefined" ? window.__uid : null;
    const isHost = !!(createdBy && myId && createdBy === myId);
    if (isHost) {
      advanceToPlayingIfAllAckedDB(currentRoomId).catch(() => {});
    }
  }

  // playing: 待機画面→メイン画面へ全員同期
  if (phase === 'playing') {
    // role modalを閉じる
    document.getElementById("self-role-modal")?.classList.add("hidden");

    const waiting = document.getElementById("waiting-screen");
    const main = document.getElementById("main-screen");
    if (waiting?.classList.contains("active")) {
      waiting.classList.remove("active");
      main?.classList.add("active");
      // 画面切替直後に描画（初回はここで描画しないと待機画面分岐でreturnしてしまう）
      const renderAll = typeof window !== "undefined" ? window.renderAll : null;
      if (renderAll && typeof renderAll === "function") {
        renderAll();
      }
    }

    // 開始準備完了後：ステージ抽選ポップアップ（ホストが1回抽選→全員同期）
    maybeAutoStageRoulette(roomData);
  }
}

let lastStageModalTurn = null;
let lastStageRequestedTurn = null;

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

  const modal = document.getElementById("stage-roulette-modal");
  const subtitle = modal?.querySelector(".modal-subtitle");
  const items = document.getElementById("stage-roulette-items");
  const startBtn = document.getElementById("stage-roulette-start");

  // 旧挙動：ホストがボタンで開始
  const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
  const myId = typeof window !== "undefined" ? window.__uid : null;
  const isHost = !!(createdBy && myId && createdBy === myId);
  // 自動抽選に戻す：ボタンは使わない（ただし内部的にclickする）
  if (startBtn) startBtn.style.display = "none";

  // 毎ターンの初めに必ず抽選（currentStageの有無には依存しない）
  if (lastStageModalTurn !== turn) {
    lastStageModalTurn = turn;
    subtitle && (subtitle.textContent = "ステージ抽選中……");
    if (items) items.innerHTML = "";
    modal?.classList.remove("hidden");
    setStageRoulettePendingLog(true);

    // ホストだけが1回だけ抽選を実行（UIハンドラのclickを流用）
    if (isHost && startBtn && lastStageRequestedTurn !== turn) {
      lastStageRequestedTurn = turn;
      startBtn.click();
    }
  }

  // そのターンの抽選が完了したら「抽選中……」表示は消す（結果は上部ステータスに反映）
  const resolvedThisTurn = stageTurn === turn && !!currentStage;
  if (!resolvedThisTurn) return;
  setStageRoulettePendingLog(false);

  // ステージ決定：結果を表示して閉じる
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
  
  await updateGameState(roomId, {
    'gameState.currentStage': stage,
    'gameState.stageTurn': GameState.turn,
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
export { createRoomAndStartGame, joinRoomAndSync, syncToFirebase, stopRoomSync, startGameAsHost, acknowledgeRoleReveal };

// 新しいデフォルト同期API（チャット追加もここにぶら下げる想定）
export { roomClient };
