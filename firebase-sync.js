// Firebase同期処理
import { createRoom, joinRoom, subscribeToRoom, updateGameState, updatePlayerState, addLog, saveRandomResult, startGameAsHost as startGameAsHostDB, acknowledgeRoleReveal as acknowledgeRoleRevealDB, advanceToPlayingIfAllAcked as advanceToPlayingIfAllAckedDB, applySuccess as applySuccessDB, applyFail as applyFailDB, applyDoctorPunch as applyDoctorPunchDB, applyDoctorSkip as applyDoctorSkipDB, proceedToNextPlayerAfterDoctorPunch as proceedToNextPlayerAfterDoctorPunchDB, applyWolfAction as applyWolfActionDB, activateWolfAction as activateWolfActionDB, wolfDecision as wolfDecisionDB, resolveWolfAction as resolveWolfActionDB, resolveWolfActionRoulette as resolveWolfActionRouletteDB, clearWolfActionNotification as clearWolfActionNotificationDB, clearDoctorSkipNotification as clearDoctorSkipNotificationDB, clearTurnResult as clearTurnResultDB, proceedToNextPlayerChallenge as proceedToNextPlayerChallengeDB, computeStartSubphase, identifyWolf as identifyWolfDB, startDiscussionPhase as startDiscussionPhaseDB, endDiscussionPhase as endDiscussionPhaseDB, extendDiscussionPhase as extendDiscussionPhaseDB } from "./firebase-db.js";
import { signInAnonymously, getCurrentUserId, getCurrentUser } from "./firebase-auth.js";
import { firestore } from "./firebase-config.js";
import { doc, getDoc, updateDoc, runTransaction } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
import { createRoomClient } from "./room-client.js";
import { $ } from "./game-state.js";
import { switchScreen } from "./ui-modals.js";

let currentRoomId = null;
let roomUnsubscribe = null;
let isSyncing = false;
let lastPlayerIndex = -1;
let lastSubphase = null;
let lastPhase = null;
let discussionTimerInterval = null;
let lastDiscussionEndTime = null;
let previousDiscussionPhase = false;
let missionBriefShown = false;
let lastLogMessage = null; // 重複ログ防止用
let lastAnnouncementTitle = null; // 重複アナウンス防止用
let lastTurnResult = null; // ターン結果の重複防止用
let previousTurn = null; // 前回のターン番号（ターン切り替え検出用）
let lastStageAnnouncementTurn = null; // ステージ選出アナウンスの重複防止用
let lastChallengeAnnouncementPlayerIndex = null; // 挑戦アナウンスの重複防止用
let lastSuccessAnnouncementPlayerIndex = null; // 成功アナウンスの重複防止用
let lastFailAnnouncementPlayerIndex = null; // 失敗アナウンスの重複防止用
let lastDoctorPunchAnnouncement = null; // ドクター神拳アナウンスの重複防止用

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
    doctorSkip: (roomId, payload) => handleDoctorSkipAction(payload, roomId),
    wolfAction: (roomId, payload) => handleWolfActionAction(payload, roomId),
    stageRoulette: (roomId, payload) => handleStageRouletteAction(payload, roomId),
    updateConfig: (roomId, payload) => handleUpdateConfigAction(payload, roomId),
    clearWolfActionNotification: async (roomId, payload) => {
      await clearWolfActionNotificationDB(roomId);
    },
    clearDoctorSkipNotification: async (roomId, payload) => {
      await clearDoctorSkipNotificationDB(roomId);
    },
    clearTurnResult: async (roomId, payload) => {
      await clearTurnResultDB(roomId);
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
 * 統一アナウンスポップアップを表示
 * @param {string} title - タイトル
 * @param {string|null} subtitle - サブタイトル（オプション）
 * @param {string|null} logMessage - ログメッセージ（オプション）
 * @param {number} autoCloseDelay - 自動閉じるまでの時間（ミリ秒、デフォルト2000）
 */
let announcementTimeout = null;
let announcementQueue = []; // アナウンスキュー
let isProcessingQueue = false; // キュー処理中フラグ

function showAnnouncement(title, subtitle = null, logMessage = null, autoCloseDelay = 2000, requireOk = false, isWolfAction = false, gmOnly = false, onOk = null) {
  const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
  const myId = typeof window !== "undefined" ? window.__uid : null;
  const isGM = !!(createdBy && myId && createdBy === myId);
  
  // GM画面のみの場合はGM以外は表示しない
  if (gmOnly && !isGM) {
    return;
  }
  
  // 継続表示（autoCloseDelay=0 かつ requireOk=false）のみキューに追加せず直接表示
  // それ以外（OKボタンが必要なものなど）はキューに追加して順番に表示
  if (autoCloseDelay === 0 && !requireOk) {
    _showAnnouncementDirect(title, subtitle, logMessage, autoCloseDelay, requireOk, isWolfAction, gmOnly, onOk);
    return;
  }
  
  // キューに追加
  announcementQueue.push({
    title,
    subtitle,
    logMessage,
    autoCloseDelay,
    requireOk,
    isWolfAction,
    gmOnly,
    onOk,
  });
  
  // キューを処理
  processAnnouncementQueue();
}

/**
 * 継続表示が表示中かチェック
 */
function _isContinuousAnnouncementShowing() {
  const modal = document.getElementById("announcement-modal");
  const titleEl = document.getElementById("announcement-title");
  if (!modal || !titleEl || modal.classList.contains("hidden")) {
    return false;
  }
  const currentTitle = titleEl.textContent;
  return currentTitle === "人狼が操作中です。" || currentTitle === "ドクターが操作中です。";
}

/**
 * ポップアップのキューが空で、表示中のポップアップもないかチェック
 */
function isAnnouncementQueueEmpty() {
  // キューにアイテムが残っている場合はfalse
  if (announcementQueue.length > 0) {
    return false;
  }
  
  // 継続表示が表示中の場合はfalse
  if (_isContinuousAnnouncementShowing()) {
    return false;
  }
  
  // 通常のポップアップが表示中の場合はfalse
  const modal = document.getElementById("announcement-modal");
  if (modal && !modal.classList.contains("hidden")) {
    return false;
  }
  
  // キュー処理中の場合もfalse
  if (isProcessingQueue) {
    return false;
  }
  
  return true;
}

/**
 * アナウンスキューを処理（順番に表示）
 */
function processAnnouncementQueue() {
  // 既に処理中またはキューが空の場合は何もしない
  if (isProcessingQueue || announcementQueue.length === 0) {
    return;
  }
  
  // 継続表示が表示中の場合は、キュー処理をブロック（継続表示は表示し続ける）
  if (_isContinuousAnnouncementShowing()) {
    return;
  }
  
  isProcessingQueue = true;
  _processNextAnnouncement();
}

/**
 * キューから次のアナウンスを表示
 */
function _processNextAnnouncement() {
  // キューが空の場合は処理終了
  if (announcementQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }
  
  // 継続表示が表示中の場合は、キュー処理をブロック（継続表示は表示し続ける）
  if (_isContinuousAnnouncementShowing()) {
    isProcessingQueue = false;
    return;
  }
  
  // キューから最初のアナウンスを取得
  const item = announcementQueue.shift();
  
  // アナウンスを表示
  _showAnnouncementDirect(
    item.title,
    item.subtitle,
    item.logMessage,
    item.autoCloseDelay,
    item.requireOk,
    item.isWolfAction,
    item.gmOnly,
    item.onOk
  );
}

/**
 * アナウンスを直接表示（内部関数）
 */
function _showAnnouncementDirect(title, subtitle = null, logMessage = null, autoCloseDelay = 2000, requireOk = false, isWolfAction = false, gmOnly = false, onOk = null) {
  const modal = document.getElementById("announcement-modal");
  const titleEl = document.getElementById("announcement-title");
  const subtitleEl = document.getElementById("announcement-subtitle");
  const actionsEl = document.getElementById("announcement-actions");
  const okBtn = document.getElementById("announcement-ok");
  
  if (!modal || !titleEl) {
    // モーダルが見つからない場合、キュー処理を続行
    if (isProcessingQueue) {
      _processNextAnnouncement();
    }
    return;
  }
  
  // 既に表示されている場合でも、同じタイトルの場合は更新する（継続表示用）
  const isSameTitle = titleEl.textContent === title;
  
  // 重複チェック：同じタイトルとログメッセージの場合はスキップ（継続表示のみ）
  if (isSameTitle && title === lastAnnouncementTitle && logMessage === lastLogMessage && autoCloseDelay === 0) {
    return; // 継続表示の場合は何もしない
  }
  
  // 既存のタイマーをクリア
  if (announcementTimeout) {
    clearTimeout(announcementTimeout);
    announcementTimeout = null;
  }
  
  // 妨害アニメーション用のクラスを追加/削除
  if (isWolfAction) {
    modal.classList.add("wolf-action");
    setTimeout(() => {
      modal.classList.remove("wolf-action");
    }, 800);
  } else {
    modal.classList.remove("wolf-action");
  }
  
  titleEl.textContent = title;
  lastAnnouncementTitle = title;
  
  if (subtitle && subtitleEl) {
    subtitleEl.textContent = subtitle;
    subtitleEl.style.display = "block";
  } else if (subtitleEl) {
    subtitleEl.style.display = "none";
  }
  
  // OKボタンの表示/非表示
  if (requireOk && actionsEl && okBtn) {
    actionsEl.style.display = "flex";
    // OKボタンのイベントリスナーを設定
    const handleOk = () => {
      modal.classList.add("hidden");
      actionsEl.style.display = "none";
      lastAnnouncementTitle = null; // リセット
      lastLogMessage = null; // リセット
      // コールバックを実行
      if (onOk && typeof onOk === "function") {
        onOk();
      }
      okBtn.removeEventListener("click", handleOk);
      // キュー処理を続行
      if (isProcessingQueue) {
        _processNextAnnouncement();
      }
    };
    // 既存のイベントリスナーを削除してから追加
    okBtn.replaceWith(okBtn.cloneNode(true));
    const newOkBtn = document.getElementById("announcement-ok");
    newOkBtn.addEventListener("click", handleOk);
  } else if (actionsEl) {
    actionsEl.style.display = "none";
  }
  
  modal.classList.remove("hidden");
  
  // ログを追加（初回表示時のみ、重複チェック）
  if (logMessage && logMessage !== lastLogMessage) {
    lastLogMessage = logMessage;
    const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    if (roomId) {
      syncToFirebase("log", {
        logType: "system",
        logMessage: logMessage,
        roomId,
      }).catch((e) => {
        console.error("Failed to add log:", e);
      });
    }
  }
  
  // 自動で閉じる（autoCloseDelayが0の場合は閉じない、requireOkがtrueの場合は閉じない）
  if (autoCloseDelay > 0 && !requireOk) {
    announcementTimeout = setTimeout(() => {
      if (modal && !modal.classList.contains("hidden")) {
        modal.classList.add("hidden");
        lastAnnouncementTitle = null; // リセット
        lastLogMessage = null; // リセット
      }
      announcementTimeout = null;
      // コールバックを実行（onOkが指定されている場合）
      if (onOk && typeof onOk === "function") {
        onOk();
      }
      // キュー処理を続行
      if (isProcessingQueue) {
        _processNextAnnouncement();
      }
    }, autoCloseDelay);
  }
}

/**
 * ゲーム開始時の極秘命令ポップアップを表示（GM画面のみ）
 */
function showMissionBrief() {
  const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
  const myId = typeof window !== "undefined" ? window.__uid : null;
  const isGM = !!(createdBy && myId && createdBy === myId);
  
  // GMのみ表示
  if (!isGM) return;
  
  const modal = document.getElementById("mission-brief-modal");
  const contentEl = document.getElementById("mission-brief-content");
  const closeBtn = document.getElementById("mission-brief-close");
  
  if (!modal || !contentEl) return;

  const missionText = `極秘命令。
 ロドスは特別小隊を編成する。
本作戦において、隊員の身元、経歴、所属は一切開示されない。
 参加者同士が互いを特定することも禁止される。
理由は、内部に敵対勢力が潜伏している可能性があるためである。
よって、本作戦は完全な相互不信の状態から開始される。
任務は5段階。
 成否はすべて記録され、最終的な勝敗が決定される。
以上。作戦を開始する。`;

  // テキストを行ごとに分割して表示（いい感じに区切る）
  const lines = missionText.split('\n');
  contentEl.innerHTML = lines.map(line => {
    if (line.trim() === '') return '<br>';
    return `<p style="margin: 8px 0;">${line.trim()}</p>`;
  }).join('');

  // モーダルを表示
  modal.classList.remove("hidden");

  // 閉じるボタンのイベント
  if (closeBtn) {
    const handleClose = () => {
      modal.classList.add("hidden");
      // ゲーム開始アナウンスを表示
      showAnnouncement(
        "作戦準備を行ってください",
        "GMのステージロールにより開始されます。",
        "ゲーム開始",
        2000,
        false,
        false,
        true // GM画面のみ
      );
      closeBtn.removeEventListener("click", handleClose);
    };
    closeBtn.addEventListener("click", handleClose);
  }
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
  const previousPlayerIndex = GameState.currentPlayerIndex;
  const previousSubphase = GameState.subphase;
  const previousPhase = GameState.phase;
  const previousTurn = GameState.turn || 1;
  
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
  GameState.doctorHasFailed = gameState.doctorHasFailed === true;
  GameState.gameResult = gameState.gameResult || null;
  GameState.discussionPhase = gameState.discussionPhase === true;
  GameState.discussionEndTime = gameState.discussionEndTime || null;
  
  // ターン結果ポップアップを表示（自動で閉じる、重複防止）
  // 会議フェーズが開始される前に表示する必要があるため、ここで処理
  const currentDiscussionPhase = GameState.discussionPhase;
  if (gameState.turnResult && gameState.turnResult !== lastTurnResult) {
    lastTurnResult = gameState.turnResult;
    // ターン結果を表示する際のターン番号（次のターンに進む前に保存された値）
    const turn = gameState.turnResultTurn || GameState.turn || 1;
    if (gameState.turnResult === "success") {
      showAnnouncement(
        "作戦結果：成功",
        "ターン結果に〇を付けて次のターンへ進みます。",
        `ターン${turn}結果：〇`,
        2000,
        false,
        false,
        true, // GM画面のみ
        async () => {
          // ターン結果ポップアップが閉じた後、会議フェーズを開始
          // 会議フェーズの開始は既にendTurnAndPrepareNextで設定されているが、
          // タイマー表示はこのコールバック後に実行される
          const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
          if (roomId) {
            try {
              // 会議フェーズを開始（discussionPhaseをtrueに設定）
              const roomRef = doc(firestore, "rooms", roomId);
              await updateDoc(roomRef, {
                "gameState.discussionPhase": true,
              });
            } catch (e) {
              console.error("Failed to start discussion phase:", e);
            }
          }
        }
      );
    } else if (gameState.turnResult === "failure") {
      showAnnouncement(
        "作戦結果：失敗",
        "ターン結果に×を付けて次のターンへ進みます。",
        `ターン${turn}結果：×`,
        2000,
        false,
        false,
        true, // GM画面のみ
        async () => {
          // ターン結果ポップアップが閉じた後、会議フェーズを開始
          // 会議フェーズの開始は既にendTurnAndPrepareNextで設定されているが、
          // タイマー表示はこのコールバック後に実行される
          const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
          if (roomId) {
            try {
              // 会議フェーズを開始（discussionPhaseをtrueに設定）
              const roomRef = doc(firestore, "rooms", roomId);
              await updateDoc(roomRef, {
                "gameState.discussionPhase": true,
              });
            } catch (e) {
              console.error("Failed to start discussion phase:", e);
            }
          }
        }
      );
    }
    
    // ターン結果をクリア
    const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    if (roomId) {
      setTimeout(async () => {
        try {
          await syncToFirebase("clearTurnResult", { roomId });
        } catch (e) {
          console.error("Failed to clear turn result:", e);
        }
      }, 2000);
    }
  } else if (!gameState.turnResult) {
    lastTurnResult = null; // ターン結果がクリアされたらリセット
  }
  
  // 前回の会議フェーズ状態を更新（ターン結果表示後に会議フェーズを処理するため）
  previousDiscussionPhase = currentDiscussionPhase;
  
  // ターン切り替え時のポップアップを表示（1ターン目も含む）
  if (previousTurn !== GameState.turn && GameState.phase === "playing") {
    showAnnouncement(
      `${GameState.turn}ターン目`,
      null,
      `${GameState.turn}ターン目開始`,
      2000,
      false,
      false,
      true // GM画面のみ
    );
  }
  
  // 挑戦開始フェーズ（challenge_start）：「○○の挑戦です」を表示してから妨害フェーズに移行
  if (GameState.phase === "playing" && GameState.subphase === "challenge_start") {
    const order = GameState.playerOrder || Object.keys(players);
    const currentPlayerId = order[GameState.currentPlayerIndex];
    const currentPlayer = players[currentPlayerId];
    // プレイヤーが変わった時、または前回のサブフェーズがchallenge_startでない時に表示
    if (currentPlayer && (previousPlayerIndex !== GameState.currentPlayerIndex || previousSubphase !== "challenge_start")) {
      showAnnouncement(
        `${currentPlayer.name}の挑戦です。`,
        null,
        `${currentPlayer.name}の挑戦`,
        2000,
        false,
        false,
        true, // GM画面のみ
        async () => {
          // 「○○の挑戦です」が表示された後、妨害フェーズに移行
          const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
          if (!roomId) return;
          
          const roomRef = doc(firestore, "rooms", roomId);
          await runTransaction(firestore, async (tx) => {
            const snap = await tx.get(roomRef);
            if (!snap.exists()) return;
            const data = snap.data();
            
            const playersObj = data?.players || {};
            const order = Array.isArray(data?.gameState?.playerOrder) && data.gameState.playerOrder.length
              ? data.gameState.playerOrder
              : Object.keys(playersObj);
            const currentPlayerIndex = Number(data?.gameState?.currentPlayerIndex || 0);
            
            // 人狼の妨害フェーズを設定（人狼のコストが残っている場合のみ）
            const wolfPlayerId = Object.keys(playersObj).find(pid => playersObj[pid]?.role === "wolf");
            const wolfPlayer = wolfPlayerId ? playersObj[wolfPlayerId] : null;
            const wolfRes = wolfPlayer?.resources || {};
            const wolfRemain = Number(wolfRes.wolfActionsRemaining || 0);
            
            if (wolfRemain > 0 && wolfPlayerId) {
              // 人狼の妨害フェーズ
              tx.update(roomRef, {
                'gameState.subphase': 'wolf_decision',
                'gameState.wolfDecisionPlayerId': wolfPlayerId,
                'gameState.wolfActionRequest': null,
              });
            } else {
              // 妨害フェーズなし、直接挑戦フェーズ（await_result）へ
              tx.update(roomRef, {
                'gameState.subphase': 'await_result',
                'gameState.wolfDecisionPlayerId': null,
                'gameState.wolfActionRequest': null,
              });
            }
          });
        }
      );
    }
  }
  
  // await_doctorフェーズになった時は「ドクターが操作中です。」が表示される（handlePhaseUIで処理）
  // ここでは特に処理しない
  
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
  handlePhaseUI(roomData, previousPhase);
  
  // ログを同期
  if (roomData.logs && roomData.logs.length > 0) {
    syncLogs(roomData.logs);
  }
}

function handlePhaseUI(roomData, previousPhase = null) {
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

      // GMの場合は、self-role-okボタンを無効化（gm-roles-modalのOKボタンでゲーム開始）
      if (isGM) {
        okBtn?.setAttribute("disabled", "true");
        okBtn && (okBtn.textContent = "GMは役職一覧のOKボタンでゲーム開始");
        waitText && (waitText.textContent = "ゲスト全員がOKを押すのを待っています");
        waitText?.classList.remove("hidden");
      } else if (alreadyAcked) {
        okBtn?.setAttribute("disabled", "true");
        okBtn && (okBtn.textContent = "OK済み");
        waitText && (waitText.textContent = "開始待機中…（全員のOKを待っています）");
        waitText?.classList.remove("hidden");
      } else {
        okBtn?.removeAttribute("disabled");
        okBtn && (okBtn.textContent = "OK");
        waitText?.classList.add("hidden");
      }

      // GMの場合でも、self-role-modalを常に表示（役職一覧モーダルと同時に表示可能）
      // revealingフェーズ中は、OK済みでもモーダルを閉じない
      if (modal) {
        modal.classList.remove("hidden");
      }
    }
    
    // GM：全員の役職を周知（役職一覧を直接表示）
    if (isGM) {
      const rolesModal = document.getElementById("gm-roles-modal");
      const gmRolesOkBtn = document.getElementById("gm-roles-ok");
      
      // revealingフェーズに入った時に、前回の表示フラグをリセット
      if (rolesModal && previousPhase !== 'revealing') {
        delete rolesModal.dataset.shown;
      }
      
      // 役職一覧を表示（revealingフェーズに入るたびに表示）
      if (rolesModal && !rolesModal.dataset.shown) {
        rolesModal.dataset.shown = "true";
        showGMRolesModal(roomData);
      }
      
      // GMのOKボタンの有効/無効を制御（ゲスト全員がOKを押した場合のみ有効化）
      if (gmRolesOkBtn) {
        const playersObj = roomData.players || {};
        const playerIds = Object.keys(playersObj);
        const gmId = createdBy;
        
        // ゲスト（GM以外）のIDを取得
        const guestIds = playerIds.filter(pid => pid !== gmId);
        
        // ゲスト全員がOKを押したかチェック
        const allGuestsAcked = guestIds.length > 0 && guestIds.every((pid) => acks[pid] === true);
        
        if (allGuestsAcked && !alreadyAcked) {
          // ゲスト全員がOKを押していて、GMがまだOKを押していない場合、ボタンを有効化
          gmRolesOkBtn.removeAttribute("disabled");
          gmRolesOkBtn.textContent = "ゲーム開始";
        } else if (allGuestsAcked && alreadyAcked) {
          // ゲスト全員がOKを押していて、GMもOKを押した場合、ボタンを無効化（既にゲーム開始済み）
          gmRolesOkBtn.setAttribute("disabled", "true");
          gmRolesOkBtn.textContent = "ゲーム開始済み";
        } else {
          // ゲストがまだOKを押していない場合、ボタンを無効化
          gmRolesOkBtn.setAttribute("disabled", "true");
          const ackedCount = guestIds.filter(pid => acks[pid] === true).length;
          gmRolesOkBtn.textContent = `ゲスト待機中 (${ackedCount}/${guestIds.length})`;
        }
      }
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
      const renderAllLocal = typeof window !== "undefined" ? window.renderAll : null;
      if (renderAllLocal && typeof renderAllLocal === "function") {
        renderAllLocal();
      }
      
      // ゲーム開始時に極秘命令ポップアップを表示（一度だけ）
      if (!missionBriefShown) {
        missionBriefShown = true;
        showMissionBrief();
      }
    }

    // GM：人狼妨害の選出リクエストをチェック
    if (isGM) {
      checkWolfActionRequest(roomData);
      checkDoctorSkipNotification(roomData);
      
      // GM画面：サブフェーズに応じた操作中ポップアップを表示（継続表示）
      const subphase = gameState.subphase;
      const playersObj = roomData.players || {};
      
      // 「○○の挑戦です。」がキューに残っている場合は、継続表示を開始しない
      // （「○○の挑戦です。」が表示されてから妨害フェーズに移行するため）
      const hasChallengeAnnouncementInQueue = announcementQueue.some(item => 
        item.title && item.title.endsWith("の挑戦です。")
      );
      
      if (subphase === "challenge_start") {
        // challenge_startフェーズでは継続表示を開始しない（「○○の挑戦です」が表示される）
        // 継続表示があれば閉じる
        const announcementModal = document.getElementById("announcement-modal");
        if (announcementModal && !announcementModal.classList.contains("hidden")) {
          const titleEl = document.getElementById("announcement-title");
          if (titleEl && (titleEl.textContent === "人狼が操作中です。" || titleEl.textContent === "ドクターが操作中です。")) {
            announcementModal.classList.add("hidden");
            // 継続表示が閉じられたので、キューがあれば処理を再開
            processAnnouncementQueue();
          }
        }
      } else if ((subphase === "wolf_decision" || subphase === "wolf_resolving") && !hasChallengeAnnouncementInQueue) {
        // 人狼が操作中（継続表示）
        showAnnouncement("人狼が操作中です。", null, null, 0, false, false, true); // GM画面のみ、継続表示
      } else if (subphase === "await_doctor" && !hasChallengeAnnouncementInQueue) {
        // ドクターが操作中（継続表示）
        showAnnouncement("ドクターが操作中です。", null, null, 0, false, false, true); // GM画面のみ、継続表示
      } else {
        // 他のフェーズではアナウンスを閉じる
        const announcementModal = document.getElementById("announcement-modal");
        if (announcementModal && !announcementModal.classList.contains("hidden")) {
          const titleEl = document.getElementById("announcement-title");
          if (titleEl && (titleEl.textContent === "人狼が操作中です。" || titleEl.textContent === "ドクターが操作中です。")) {
            announcementModal.classList.add("hidden");
            // 継続表示が閉じられたので、キューがあれば処理を再開
            processAnnouncementQueue();
          }
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

  // final_phase: 最終フェーズ（人狼投票）
  if (phase === 'final_phase') {
    const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
    const myId = typeof window !== "undefined" ? window.__uid : null;
    const isGM = !!(createdBy && myId && createdBy === myId);
    const playersObj = roomData.players || {};
    const myRole = playersObj[myId]?.role || null;
    const isDoctor = myRole === "doctor";
    const isCitizen = myRole === "citizen";

    // 市民とドクター：人狼投票モーダルを表示
    if (isDoctor || isCitizen) {
      showFinalPhaseModal(roomData);
    } else if (isGM) {
      // GM：投票待機ポップアップを表示
      showAnnouncement("最終判定フェーズ（市民とドクターが投票中）", null, null, 2000, false, false, true); // GM画面のみ
    } else {
      // その他の参加者：待機画面を表示
      const waiting = document.getElementById("waiting-screen");
      const main = document.getElementById("main-screen");
      const participant = document.getElementById("participant-screen");
      
      if (main) main.classList.remove("active");
      if (participant) participant.classList.remove("active");
      if (waiting) {
        waiting.classList.add("active");
        const waitingTitle = waiting.querySelector(".waiting-title");
        if (waitingTitle) {
          waitingTitle.textContent = "最終判定フェーズ（投票中）";
        }
      }
    }
  }

  // finished: ゲーム終了（勝利画面表示）
  if (phase === 'finished') {
    // finished直前/直後に通知が入るケースがあるため、GM側はここでもチェック
    const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
    const myId = typeof window !== "undefined" ? window.__uid : null;
    const isGM = !!(createdBy && myId && createdBy === myId);
    if (isGM) {
      checkDoctorSkipNotification(roomData);
    }

    // ゲーム終了時は「ドクターが操作中です」「人狼が操作中です」のアナウンスをクリア
    const announcementModal = document.getElementById("announcement-modal");
    if (announcementModal && !announcementModal.classList.contains("hidden")) {
      const titleEl = document.getElementById("announcement-title");
      if (titleEl && (titleEl.textContent === "人狼が操作中です。" || titleEl.textContent === "ドクターが操作中です。")) {
        announcementModal.classList.add("hidden");
        // 継続表示が閉じられたので、キューがあれば処理を再開
        processAnnouncementQueue();
      }
    }
    
    const gameResult = gameState.gameResult;
    if (gameResult) {
      showGameResult(roomData, gameResult);
    }
  }
  
  // waitingフェーズに戻った時もアナウンスをクリア
  if (phase === 'waiting' && previousPhase !== 'waiting') {
    const announcementModal = document.getElementById("announcement-modal");
    if (announcementModal && !announcementModal.classList.contains("hidden")) {
      const titleEl = document.getElementById("announcement-title");
      if (titleEl && (titleEl.textContent === "人狼が操作中です。" || titleEl.textContent === "ドクターが操作中です。")) {
        announcementModal.classList.add("hidden");
        // 継続表示が閉じられたので、キューがあれば処理を再開
        processAnnouncementQueue();
      }
    }
  }

  // 会議フェーズの処理
  handleDiscussionPhase(roomData);
}

/**
 * 会議フェーズのUI管理とタイマー更新
 */
function handleDiscussionPhase(roomData) {
  const gameState = roomData.gameState || {};
  const discussionPhase = gameState.discussionPhase === true;
  const discussionEndTime = gameState.discussionEndTime || null;
  const userId = getCurrentUserId();
  const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
  const myId = typeof window !== "undefined" ? window.__uid : null;
  const isGM = !!(createdBy && myId && createdBy === myId);

  const modal = document.getElementById("discussion-modal");
  const timerEl = document.getElementById("discussion-timer");

  // タイマーをクリア
  if (discussionTimerInterval) {
    clearInterval(discussionTimerInterval);
    discussionTimerInterval = null;
  }

  // 会議フェーズが終了した場合、モーダルを閉じる
  if (!discussionPhase) {
    if (modal) {
      modal.classList.add("hidden");
    }
    lastDiscussionEndTime = null;
    previousDiscussionPhase = false;
    return;
  }
  
  // 会議フェーズが開始された場合でも、ポップアップのキューが残っている場合は待機
  // （ターン結果のポップアップなどが表示されている場合は、会議フェーズのタイマー表示を遅延させる）
  if (discussionPhase && !previousDiscussionPhase) {
    // 会議フェーズが新しく開始された場合
    // ポップアップのキューが空になるまで待機
    if (!isAnnouncementQueueEmpty()) {
      // キューが空になるまで定期的にチェック
      const checkInterval = setInterval(() => {
        if (isAnnouncementQueueEmpty()) {
          clearInterval(checkInterval);
          handleDiscussionPhase(roomData);
        }
      }, 100); // 100msごとにチェック
      
      // タイムアウト（最大10秒待機）
      setTimeout(() => {
        clearInterval(checkInterval);
        handleDiscussionPhase(roomData);
      }, 10000);
      
      return;
    }
  }

  // GMのみ会議フェーズモーダルを表示
  if (!isGM) {
    if (modal) {
      modal.classList.add("hidden");
    }
    return;
  }

  // 会議フェーズが開始された場合、モーダルを表示
  if (modal && discussionEndTime) {
    modal.classList.remove("hidden");
    
    // タイマーを更新
    function updateTimer() {
      if (!timerEl || !discussionEndTime) return;
      
      const now = Date.now();
      const remaining = Math.max(0, discussionEndTime - now);
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      const timeString = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      
      if (timerEl) {
        timerEl.textContent = timeString;
      }
      
      // タイマーが0になった場合、自動で会議フェーズを終了
      if (remaining <= 0) {
        if (discussionTimerInterval) {
          clearInterval(discussionTimerInterval);
          discussionTimerInterval = null;
        }
        endDiscussionPhaseDB(currentRoomId).catch((e) => {
          console.error("Failed to end discussion phase:", e);
        });
      }
    }

    // タイマーが更新された場合、または初回表示の場合、インターバルを再設定
    const currentEndTime = Number(discussionEndTime);
    const lastEndTime = Number(lastDiscussionEndTime);
    
    if (currentEndTime !== lastEndTime || !discussionTimerInterval) {
      if (discussionTimerInterval) {
        clearInterval(discussionTimerInterval);
        discussionTimerInterval = null;
      }
      lastDiscussionEndTime = currentEndTime;
      updateTimer(); // 即座に更新
      discussionTimerInterval = setInterval(updateTimer, 1000);
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
  
  // 通常の妨害発動通知（ゲストUIから操作された場合はOKボタンを要求）
  if (notification && notification.timestamp && notification.timestamp !== lastNotificationTimestamp) {
    lastNotificationTimestamp = notification.timestamp;
    // 統一アナウンスモーダルで妨害発動を表示
    const announcementTitle = notification.announcementTitle || `妨害『${notification.text}』が発動されました`;
    const announcementSubtitle = notification.announcementSubtitle || null;
    const logMessage = notification.logMessage || `妨害『${notification.text}』が発動されました`;
    showAnnouncement(announcementTitle, announcementSubtitle, logMessage, 0, true, true, true); // OKボタンを要求、妨害アニメーション、GM画面のみ
  }
  
  // フェーズが変わったら職業ルーレットモーダルを閉じる
  if (subphase !== "wolf_resolving") {
    const jobModal = document.getElementById("job-roulette-modal");
    if (jobModal && !jobModal.classList.contains("hidden")) {
      jobModal.classList.add("hidden");
    }
  }
}

// GM：ドクター神拳「不使用」通知をチェック
let lastDoctorSkipNotificationTimestamp = null;
function checkDoctorSkipNotification(roomData) {
  const gameState = roomData.gameState || {};
  const notif = gameState.doctorSkipNotification || null;
  if (!notif || !notif.timestamp) return;
  if (notif.timestamp === lastDoctorSkipNotificationTimestamp) return;

  lastDoctorSkipNotificationTimestamp = notif.timestamp;

  const playersObj = roomData.players || {};
  const pid = notif.playerId || null;
  const name = pid && playersObj[pid]?.name ? playersObj[pid].name : "プレイヤー";

  showAnnouncement(
    `${name}の挑戦は失敗しました。`,
    null,
    `${name}の挑戦：×`,
    2000,
    false,
    false,
    true // GM画面のみ
  );

  // 表示後は通知をクリア（重複表示防止）
  const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  if (roomId) {
    syncToFirebase("clearDoctorSkipNotification", { roomId }).catch((e) => {
      console.error("Failed to clear doctor skip notification:", e);
    });
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
  
  // 挑戦結果アナウンス（GM画面のみ）
  // ポップアップが閉じた後に次のプレイヤーの挑戦開始フェーズに移行
  showAnnouncement(
    `${name}の挑戦は成功しました。`,
    null,
        `${name}の挑戦：〇`,
        2000,
    false,
    false,
    true, // GM画面のみ
    async () => {
      // 挑戦結果ポップアップが閉じた後、次のプレイヤーの挑戦開始フェーズに移行
      const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
      if (roomId) {
        try {
          await proceedToNextPlayerChallengeDB(roomId);
        } catch (e) {
          console.error("Failed to proceed to next player challenge:", e);
        }
      }
    }
  );
}

/**
 * 失敗アクションの処理
 */
async function handleFailAction(data, roomId) {
  const userId = getCurrentUserId();
  await applyFailDB(roomId);
  const name = data?.playerName || "プレイヤー";
  const isConfirm = data?.isConfirm === true;

  // ログ: 「○ がステージ攻略に失敗しました。」
  await addLog(roomId, { type: "fail", message: `${name} がステージ攻略に失敗しました。`, playerId: userId });
  
  // 挑戦結果アナウンス
  // isConfirmがtrueの場合は神拳が残っていない（正確な判定はsubphaseで行う）
  if (isConfirm) {
    // 神拳が残っていない
    showAnnouncement(
      `${name}の挑戦は失敗しました。`,
      "ドクター神拳が残っていないため、強制的に失敗となります。",
        `${name}の挑戦：×`,
        2000,
      false,
      false,
      true, // GM画面のみ
      async () => {
        // 挑戦結果ポップアップが閉じた後、次のプレイヤーの挑戦開始フェーズに移行
        const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
        if (roomId) {
          try {
            await proceedToNextPlayerChallenge(roomId);
          } catch (e) {
            console.error("Failed to proceed to next player challenge:", e);
          }
        }
      }
    );
  }
  // isConfirmがfalseの場合は、subphaseがawait_doctorになった時にアナウンスを表示
}

/**
 * ドクター神拳を使用しない（ドクターのみ）
 * - 失敗確定となり、ターン終了に進む
 * - GM画面に「○さんの挑戦は失敗しました。」を表示する
 */
async function handleDoctorSkipAction(data, roomId) {
  await applyDoctorSkipDB(roomId);
}

/**
 * ドクター神拳アクションの処理
 */
async function handleDoctorPunchAction(data, roomId) {
  const userId = getCurrentUserId();
  await applyDoctorPunchDB(roomId);
  const target = data?.targetPlayerName || data?.playerName || "プレイヤー";
  await addLog(roomId, { type: "doctorPunch", message: `ドクター神拳発動！ ${target} の失敗はなかったことになりました。`, playerId: userId });
  
  // 神拳発動アナウンス（GM画面のみ、打ち消された旨を表示）
  showAnnouncement(
    "ドクター神拳が発動されました。",
    "失敗が帳消しにされ、成功判定とします。",
    "ドクター神拳発動",
    0,
    true, // OKボタンを要求
    false,
    true, // GM画面のみ
    async () => {
      // OKボタンを押した後に次のプレイヤーの妨害フェーズに進む
      const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
      if (roomId) {
        try {
          await proceedToNextPlayerAfterDoctorPunchDB(roomId);
        } catch (e) {
          console.error("Failed to proceed to next player after doctor punch:", e);
        }
      }
    }
  );
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
  
  // ステージ選出完了後、challenge_startに設定（「○○の挑戦です」を表示してから妨害フェーズに移行）
  const roomRef = doc(firestore, "rooms", roomId);
  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();
    
    // challenge_startに設定（「○○の挑戦です」を表示してから妨害フェーズに移行）
    tx.update(roomRef, {
      'gameState.currentStage': stage,
      'gameState.stageTurn': GameState.turn,
      'gameState.subphase': 'challenge_start', // challenge_startに設定
      'gameState.wolfDecisionPlayerId': null, // 妨害フェーズに移行するまでnull
      'gameState.wolfActionRequest': null,
    });
  });
  
  // ステージ結果アナウンス（GM画面のみ、ログメッセージでログにも記録）
  showAnnouncement(
    `作戦エリアは${stage}です`,
    null,
    `ターン${GameState.turn}のステージ: ${stage}`,
    2000,
    false,
    false,
    true // GM画面のみ
  );
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
  const wolfInitialCost = Number(data?.wolfInitialCost);

  /** @type {Record<string, any>} */
  const updates = {};
  if (Number.isFinite(min)) updates["config.stageMinChapter"] = min;
  if (Number.isFinite(max)) updates["config.stageMaxChapter"] = max;
  if (wolfActionTexts && wolfActionTexts.length) updates["config.wolfActionTexts"] = wolfActionTexts;
  if (Number.isFinite(wolfInitialCost) && wolfInitialCost >= 1 && wolfInitialCost <= 200) {
    updates["config.wolfInitialCost"] = wolfInitialCost;
  }

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

/**
 * 最終フェーズ：人狼指名モーダルを表示（GMのみ）
 */
let lastFinalPhaseVotesTimestamp = null;

function showFinalPhaseModal(roomData) {
  const modal = document.getElementById("result-modal");
  const titleEl = document.getElementById("result-title");
  const summaryEl = document.getElementById("result-summary");
  const extraEl = document.getElementById("result-extra");
  const rolesEl = document.getElementById("result-roles");
  
  if (!modal || !titleEl || !summaryEl || !extraEl) return;

  const gameState = roomData.gameState || {};
  const votes = gameState.finalPhaseVotes || {};
  const votesTimestamp = JSON.stringify(votes);
  
  // 投票データが更新された場合のみ再描画
  if (votesTimestamp === lastFinalPhaseVotesTimestamp && !modal.classList.contains("hidden")) {
    return;
  }
  lastFinalPhaseVotesTimestamp = votesTimestamp;

  const playersObj = roomData.players || {};
  const playersArr = Object.entries(playersObj).map(([id, data]) => ({
    id,
    name: data.name,
    role: data.role,
  }));

  const myId = typeof window !== "undefined" ? window.__uid : null;
  const myRole = playersObj[myId]?.role || null;
  const hasVoted = myId && votes[myId] !== undefined;

  titleEl.textContent = "最終判定: 人狼投票フェーズ";
  summaryEl.textContent = "×が過半数ですが、ドクターは一度も失敗していません。プレイヤーからの話し合いをもとに、人狼だと思うプレイヤーに投票してください。過半数の票が集まった場合のみ逆転勝利となります。";

  // プレイヤー一覧を表示
  if (rolesEl) {
    rolesEl.innerHTML = "";
    const rolesList = document.createElement("div");
    rolesList.className = "result-roles-list";

    playersArr.forEach((p) => {
      const roleItem = document.createElement("div");
      roleItem.style.display = "flex";
      roleItem.style.alignItems = "center";
      roleItem.style.gap = "8px";
      roleItem.style.padding = "6px 8px";
      roleItem.style.borderRadius = "6px";
      roleItem.style.background = "rgba(255, 255, 255, 0.03)";
      roleItem.innerHTML = `
        <span style="font-weight: 500;">${p.name}</span>
      `;
      rolesList.appendChild(roleItem);
    });

    rolesEl.appendChild(rolesList);
  }

  // 投票ボタンを表示
  extraEl.innerHTML = "";
  
  // 投票状況を表示
  const voteInfo = document.createElement("p");
  const voters = playersArr.filter(p => p.role === "doctor" || p.role === "citizen");
  const votedCount = Object.keys(votes).length;
  voteInfo.textContent = `投票状況: ${votedCount}/${voters.length}人`;
  voteInfo.style.marginBottom = "12px";
  voteInfo.style.color = "#a0a4ba";
  extraEl.appendChild(voteInfo);

  if (!hasVoted) {
    const info = document.createElement("p");
    info.textContent = "人狼だと思うプレイヤーを1名選択してください。";
    info.style.marginBottom = "12px";
    extraEl.appendChild(info);

    const btnWrap = document.createElement("div");
    btnWrap.style.display = "flex";
    btnWrap.style.flexWrap = "wrap";
    btnWrap.style.gap = "6px";
    btnWrap.style.marginTop = "8px";

    playersArr.forEach((p) => {
      const b = document.createElement("button");
      b.className = "btn ghost small";
      b.textContent = p.name;
      b.addEventListener("click", async () => {
        const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
        if (roomId) {
          try {
            await identifyWolfDB(roomId, p.id);
          } catch (e) {
            console.error("Failed to vote for wolf:", e);
            alert(e?.message || "投票に失敗しました。");
          }
        }
      });
      btnWrap.appendChild(b);
    });

    extraEl.appendChild(btnWrap);
  } else {
    const votedInfo = document.createElement("p");
    const votedPlayerId = votes[myId];
    const votedPlayer = playersArr.find(p => p.id === votedPlayerId);
    votedInfo.textContent = `投票済み: ${votedPlayer?.name || "不明"}`;
    votedInfo.style.marginBottom = "12px";
    votedInfo.style.color = "#8be6c3";
    extraEl.appendChild(votedInfo);
  }
  modal.classList.remove("hidden");
}

/**
 * ゲーム結果を表示
 */
function showGameResult(roomData, gameResult) {
  const modal = document.getElementById("result-modal");
  const titleEl = document.getElementById("result-title");
  const summaryEl = document.getElementById("result-summary");
  const extraEl = document.getElementById("result-extra");
  const rolesEl = document.getElementById("result-roles");
  
  if (!modal || !titleEl || !summaryEl || !rolesEl) return;

  const playersObj = roomData.players || {};
  const playersArr = Object.entries(playersObj).map(([id, data]) => ({
    id,
    name: data.name,
    role: data.role,
  }));

  // ゲーム結果に応じてタイトルとメッセージを設定
  if (gameResult === "citizen_win") {
    titleEl.textContent = "市民の勝利";
    summaryEl.textContent = "○が過半数を占めたため、市民の勝利です。";
  } else if (gameResult === "citizen_win_reverse") {
    titleEl.textContent = "市民の勝利（逆転）";
    summaryEl.textContent = "人狼を正しく特定したため、市民の勝利です。";
  } else if (gameResult === "wolf_win") {
    titleEl.textContent = "人狼の勝利";
    const gameState = roomData.gameState || {};
    if (gameState.doctorHasFailed) {
      summaryEl.textContent = "ドクターが失敗したため、人狼の勝利です。";
    } else {
      summaryEl.textContent = "×が過半数を占めたため、人狼の勝利です。";
    }
  }

  // プレイヤー一覧を表示
  rolesEl.innerHTML = "";
  const rolesList = document.createElement("div");
  rolesList.className = "result-roles-list";

  playersArr.forEach((p) => {
    const roleLabel =
      p.role === "doctor"
        ? "ドクター"
        : p.role === "wolf"
        ? "人狼"
        : "市民";
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
  extraEl.innerHTML = "";
  modal.classList.remove("hidden");
  
  // ボタンのイベントリスナーを設定
  setupResultModalButtons(roomData);
}

/**
 * 勝利画面のボタンイベントリスナーを設定
 */
function setupResultModalButtons(roomData) {
  const returnLobbyBtn = document.getElementById("result-return-lobby");
  const disbandBtn = document.getElementById("result-disband");
  
  if (returnLobbyBtn) {
    // 既存のイベントリスナーを削除してから追加
    const newBtn = returnLobbyBtn.cloneNode(true);
    returnLobbyBtn.parentNode.replaceChild(newBtn, returnLobbyBtn);
    
    newBtn.addEventListener("click", async () => {
      const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
      if (!roomId) return;
      
      try {
        const userId = getCurrentUserId();
        if (!userId) {
          throw new Error("User not authenticated");
        }
        
        // トランザクションで処理：既存のresultReturnLobbyAcksを保持しつつ、自分のIDだけをtrueに設定
        const roomRef = doc(firestore, "rooms", roomId);
        await runTransaction(firestore, async (tx) => {
          const snap = await tx.get(roomRef);
          if (!snap.exists()) throw new Error("Room not found");
          const data = snap.data();
          
          // 既存のresultReturnLobbyAcksを取得（なければ空オブジェクト）
          const existingAcks = data?.gameState?.resultReturnLobbyAcks || {};
          
          // 最初のプレイヤーが「ロビーに戻る」を押した場合は、ゲーム状態をリセット
          // resultReturnLobbyAcksが空または存在しない場合は、ゲーム状態をリセット
          const shouldResetGameState = Object.keys(existingAcks).length === 0;
          
          const updates = {};
          
          if (shouldResetGameState) {
            // ゲーム状態をwaitingフェーズにリセット（すべてのゲームパラメータをリセット）
            updates["gameState.phase"] = "waiting";
            updates["gameState.turn"] = 1;
            updates["gameState.whiteStars"] = 0;
            updates["gameState.blackStars"] = 0;
            updates["gameState.currentPlayerIndex"] = 0;
            updates["gameState.currentStage"] = null;
            updates["gameState.stageTurn"] = null;
            updates["gameState.subphase"] = "gm_stage"; // 初期値に戻す
            updates["gameState.pendingFailure"] = null;
            updates["gameState.playerOrder"] = null;
            updates["gameState.wolfDecisionPlayerId"] = null;
            updates["gameState.wolfActionRequest"] = null;
            updates["gameState.gameResult"] = null;
            updates["gameState.turnResult"] = null;
            updates["gameState.doctorHasFailed"] = false;
            updates["gameState.revealAcks"] = {}; // 役職公開の確認をリセット
            updates["gameState.finalPhaseVotes"] = {}; // 最終フェーズの投票をリセット
            updates["gameState.discussionPhase"] = false; // 会議フェーズをリセット
            updates["gameState.discussionEndTime"] = null; // 会議フェーズの終了時刻をリセット
            updates["gameState.pendingFinalPhase"] = false; // 最終フェーズ前の会議フラグをリセット
            updates["gameState.pendingFinalPhaseDiscussion"] = false; // 最終フェーズ前の10分会議フラグをリセット
            updates["gameState.pendingDoctorPunchProceed"] = null; // ドクター神拳発動後の進行フラグをリセット
            updates["gameState.lock"] = null; // 排他制御用ロックをリセット
          }
          
          // ロビーに戻る確認を記録（既存の値を保持しつつ、自分のIDだけをtrueに設定）
          updates[`gameState.resultReturnLobbyAcks.${userId}`] = true;
          
          // ゲーム状態をリセットする場合（最初のプレイヤーが「ロビーに戻る」を押したとき）は、resourcesもリセット
          if (shouldResetGameState) {
            const playersObj = data?.players || {};
            const playerIds = Object.keys(playersObj);
            
            playerIds.forEach((pid) => {
              const player = playersObj[pid];
              const role = player?.role;
              // 役職に応じてresourcesをリセット
              if (role === "wolf") {
                updates[`players.${pid}.resources.wolfActionsRemaining`] = 100;
              }
              if (role === "doctor") {
                updates[`players.${pid}.resources.doctorPunchRemaining`] = 5;
                updates[`players.${pid}.resources.doctorPunchAvailableThisTurn`] = true;
              }
              // 役職がない場合はresourcesをクリア
              if (!role) {
                updates[`players.${pid}.resources`] = {};
              }
            });
          }
          
          tx.update(roomRef, updates);
        });
        
        // 結果モーダルを閉じる
        const modal = document.getElementById("result-modal");
        if (modal) {
          modal.classList.add("hidden");
        }
        
        // 「ドクターが操作中です」「人狼が操作中です」のアナウンスをクリア
        const announcementModal = document.getElementById("announcement-modal");
        if (announcementModal && !announcementModal.classList.contains("hidden")) {
          const titleEl = document.getElementById("announcement-title");
          if (titleEl && (titleEl.textContent === "人狼が操作中です。" || titleEl.textContent === "ドクターが操作中です。")) {
            announcementModal.classList.add("hidden");
            // 継続表示が閉じられたので、キューがあれば処理を再開
            processAnnouncementQueue();
          }
        }
        
        // マッチング待機画面に戻る
        const main = document.getElementById("main-screen");
        const participant = document.getElementById("participant-screen");
        
        if (main && main.classList.contains("active")) {
          switchScreen("main-screen", "waiting-screen");
        } else if (participant && participant.classList.contains("active")) {
          switchScreen("participant-screen", "waiting-screen");
        } else {
          switchScreen("home-screen", "waiting-screen");
        }
      } catch (e) {
        console.error("Failed to return to lobby:", e);
        alert("ロビーに戻るのに失敗しました。");
      }
    });
  }
  
  if (disbandBtn) {
    // 既存のイベントリスナーを削除してから追加
    const newBtn = disbandBtn.cloneNode(true);
    disbandBtn.parentNode.replaceChild(newBtn, disbandBtn);
    
    newBtn.addEventListener("click", () => {
      if (confirm("ルームを解散してホームに戻りますか？")) {
        // ルーム同期を停止
        stopRoomSync();
        
        // 結果モーダルを閉じる
        const modal = document.getElementById("result-modal");
        if (modal) {
          modal.classList.add("hidden");
        }
        
        // ホーム画面に戻る
        const waiting = document.getElementById("waiting-screen");
        const main = document.getElementById("main-screen");
        const participant = document.getElementById("participant-screen");
        
        if (waiting && waiting.classList.contains("active")) {
          switchScreen("waiting-screen", "home-screen");
        } else if (main && main.classList.contains("active")) {
          switchScreen("main-screen", "home-screen");
        } else if (participant && participant.classList.contains("active")) {
          switchScreen("participant-screen", "home-screen");
        } else {
          switchScreen("home-screen", "home-screen");
        }
        
        // フォームをリセット
        const createForm = document.getElementById("create-room-form");
        const joinForm = document.getElementById("join-room-form");
        const roomInfo = document.getElementById("room-info");
        
        if (createForm) createForm.style.setProperty("display", "none");
        if (joinForm) joinForm.style.setProperty("display", "none");
        if (roomInfo) roomInfo.style.setProperty("display", "none");
      }
    });
  }
}

// assignRoles関数はmain.jsで定義されているため、ここでは使用しない

/**
 * ルーム同期を停止
 */
function stopRoomSync() {
  // 「ドクターが操作中です」「人狼が操作中です」のアナウンスをクリア
  const announcementModal = document.getElementById("announcement-modal");
  if (announcementModal && !announcementModal.classList.contains("hidden")) {
    const titleEl = document.getElementById("announcement-title");
    if (titleEl && (titleEl.textContent === "人狼が操作中です。" || titleEl.textContent === "ドクターが操作中です。")) {
      announcementModal.classList.add("hidden");
      // 継続表示が閉じられたので、キューがあれば処理を再開
      processAnnouncementQueue();
    }
  }
  
  if (roomUnsubscribe) {
    roomUnsubscribe();
    roomUnsubscribe = null;
  }
  currentRoomId = null;
  missionBriefShown = false; // ルーム退出時にリセット
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
  // wolfActionRequestからactionTextを取得して、対応する妨害情報を取得
  const GameState = typeof window !== 'undefined' ? window.GameState : null;
  const RoomInfo = typeof window !== 'undefined' ? window.RoomInfo : null;
  let announcementTitle = null;
  let announcementSubtitle = null;
  let logMessage = null;
  
  const wolfActionRequest = RoomInfo?.gameState?.wolfActionRequest || null;
  const actionText = wolfActionRequest?.actionText || null;
  
  if (GameState && Array.isArray(GameState.options.wolfActions) && actionText) {
    const action = GameState.options.wolfActions.find(a => a.text === actionText);
    if (action) {
      // サブタイトルに選択された職業を含める
      const baseSubtitle = action.announcementSubtitle || null;
      announcementTitle = action.announcementTitle || null;
      announcementSubtitle = baseSubtitle ? `${baseSubtitle}（使用禁止職業: ${selectedJob}）` : `使用禁止職業: ${selectedJob}`;
      logMessage = action.logMessage || null;
    }
  }
  
  return await resolveWolfActionRouletteDB(roomId, selectedJob, announcementTitle, announcementSubtitle, logMessage);
}

async function activateWolfAction(roomId, actionText, actionCost, requiresRoulette = false, rouletteOptions = null) {
  // actionTextから対応する妨害情報を取得
  const GameState = typeof window !== 'undefined' ? window.GameState : null;
  let announcementTitle = null;
  let announcementSubtitle = null;
  let logMessage = null;
  
  if (GameState && Array.isArray(GameState.options.wolfActions)) {
    const action = GameState.options.wolfActions.find(a => a.text === actionText);
    if (action) {
      announcementTitle = action.announcementTitle || null;
      announcementSubtitle = action.announcementSubtitle || null;
      logMessage = action.logMessage || null;
    }
  }
  
  return await activateWolfActionDB(roomId, actionText, actionCost, requiresRoulette, rouletteOptions, announcementTitle, announcementSubtitle, logMessage);
}

// identifyWolfDBは既にインポートされているので、そのままエクスポート
export { createRoomAndStartGame, joinRoomAndSync, syncToFirebase, stopRoomSync, startGameAsHost, acknowledgeRoleReveal, advanceToPlayingIfAllAckedDB, wolfDecision, resolveWolfAction, resolveWolfActionRoulette, activateWolfAction, showGMRolesModal, applyDoctorSkipDB, identifyWolfDB, endDiscussionPhaseDB as endDiscussionPhase, extendDiscussionPhaseDB as extendDiscussionPhase };

// 新しいデフォルト同期API（チャット追加もここにぶら下げる想定）
export { roomClient };
