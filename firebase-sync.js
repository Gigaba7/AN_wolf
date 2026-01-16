// Firebase同期処理
import { createRoom, joinRoom, subscribeToRoom, updateGameState, updatePlayerState, saveRandomResult, startGameAsHost as startGameAsHostDB, acknowledgeRoleReveal as acknowledgeRoleRevealDB, advanceToPlayingIfAllAcked as advanceToPlayingIfAllAckedDB, applySuccess as applySuccessDB, applyFail as applyFailDB, applyDoctorPunch as applyDoctorPunchDB, applyDoctorSkip as applyDoctorSkipDB, proceedToNextPlayerAfterDoctorPunch as proceedToNextPlayerAfterDoctorPunchDB, applyWolfAction as applyWolfActionDB, activateWolfAction as activateWolfActionDB, wolfDecision as wolfDecisionDB, resolveWolfAction as resolveWolfActionDB, resolveWolfActionRoulette as resolveWolfActionRouletteDB, clearWolfActionNotification as clearWolfActionNotificationDB, clearDoctorSkipNotification as clearDoctorSkipNotificationDB, clearTurnResult as clearTurnResultDB, proceedToNextPlayerChallenge as proceedToNextPlayerChallengeDB, computeStartSubphase, identifyWolf as identifyWolfDB, startDiscussionPhase as startDiscussionPhaseDB, endDiscussionPhase as endDiscussionPhaseDB, extendDiscussionPhase as extendDiscussionPhaseDB, endTurnAfterLastPlayerResult as endTurnAfterLastPlayerResultDB } from "./firebase-db.js";
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
let lastAnnouncementTitle = null; // 重複アナウンス防止用
let lastTurnResult = null; // ターン結果の重複防止用
let previousTurn = null; // 前回のターン番号（ターン切り替え検出用）
let lastDoctorPunchAutoProceedKey = null; // ドクター神拳後の自動進行（二重実行防止）
let lastDoctorPunchStateLogKey = null; // ドクター神拳状態ログ（二重出力防止）
let lastStageAnnouncementTurn = null; // ステージ選出アナウンスの重複防止用
let lastChallengeAnnouncementPlayerIndex = null; // 挑戦アナウンスの重複防止用
let lastSuccessAnnouncementPlayerIndex = null; // 成功アナウンスの重複防止用
let lastFailAnnouncementPlayerIndex = null; // 失敗アナウンスの重複防止用
let lastDoctorPunchAnnouncement = null; // ドクター神拳アナウンスの重複防止用
// let lastChallengeStartAutoAdvanceKey = null; // challenge_start の自動進行（二重実行防止） ※1.0.80以降の挙動（巻き戻し）
let lastFinalPhaseExplanationKey = null; // 最終フェーズ説明ポップアップ（二重表示防止）

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
  
  // 継続表示（操作中表示など）が出ていても、キューに通常ポップアップが溜まった場合は割り込ませる
  // （継続表示で重要ポップアップが出なくなるのを防ぐ）
  if (_isContinuousAnnouncementShowing()) {
    const modal = document.getElementById("announcement-modal");
    if (modal && !modal.classList.contains("hidden")) {
      modal.classList.add("hidden");
      lastAnnouncementTitle = null;
    }
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
  
  // 継続表示が出ている場合でも、キュー表示を優先するため割り込ませる
  if (_isContinuousAnnouncementShowing()) {
    const modal = document.getElementById("announcement-modal");
    if (modal && !modal.classList.contains("hidden")) {
      modal.classList.add("hidden");
      lastAnnouncementTitle = null;
    }
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
  
  // 重複チェック：同じタイトルの場合はスキップ（継続表示のみ）
  if (isSameTitle && title === lastAnnouncementTitle && autoCloseDelay === 0) {
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
    const handleOk = async () => {
      modal.classList.add("hidden");
      actionsEl.style.display = "none";
      lastAnnouncementTitle = null; // リセット

      try {
        // コールバックを実行
        if (onOk && typeof onOk === "function") {
          await onOk();
        }
      } catch (e) {
        console.error("Announcement onOk failed:", e);
      } finally {
        // キュー処理を続行（例外があっても止めない）
        if (isProcessingQueue) {
          _processNextAnnouncement();
        }
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
  
  // 自動で閉じる（autoCloseDelayが0の場合は閉じない、requireOkがtrueの場合は閉じない）
  if (autoCloseDelay > 0 && !requireOk) {
    announcementTimeout = setTimeout(async () => {
      if (modal && !modal.classList.contains("hidden")) {
        modal.classList.add("hidden");
        lastAnnouncementTitle = null; // リセット
      }
      announcementTimeout = null;
      try {
        // コールバックを実行（onOkが指定されている場合）
        if (onOk && typeof onOk === "function") {
          await onOk();
        }
      } catch (e) {
        console.error("Announcement onOk failed:", e);
      } finally {
        // キュー処理を続行（例外があっても止めない）
        if (isProcessingQueue) {
          _processNextAnnouncement();
        }
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
  const currentTurn = GameState.turn || 1;
  
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
  
  // プレイヤー、ターン、サブフェーズが変わった時に重複防止フラグをリセット
  if (previousPlayerIndex !== GameState.currentPlayerIndex || previousTurn !== currentTurn || previousSubphase !== GameState.subphase) {
    lastSuccessAnnouncementPlayerIndex = null;
    lastFailAnnouncementPlayerIndex = null;
    lastChallengeAnnouncementPlayerIndex = null;
    if (typeof window !== "undefined") {
      window.__previousSubphase = GameState.subphase;
    }

    // フェーズが変わった場合、継続表示（「○○が操作中です」等）を確実に閉じる
    const announcementModal = document.getElementById("announcement-modal");
    if (announcementModal && !announcementModal.classList.contains("hidden")) {
      const titleEl = document.getElementById("announcement-title");
      if (titleEl && (titleEl.textContent === "人狼が操作中です。" || titleEl.textContent === "ドクターが操作中です。")) {
        announcementModal.classList.add("hidden");
        lastAnnouncementTitle = null;
        processAnnouncementQueue();
      }
    }
  }
  
  // await_doctor_punch_resultフェーズ：ドクター神拳発動後の成功ポップアップを表示（ターン結果ポップアップより先に表示）
  // ターン結果ポップアップを表示（自動で閉じる、重複防止）
  // 会議フェーズが開始される前に表示する必要があるため、ここで処理
  const currentDiscussionPhase = GameState.discussionPhase;
  
  // await_doctor_punch_resultフェーズの処理を先に実行（ターン結果ポップアップより先に表示）
  if (GameState.phase === "playing" && GameState.subphase === "await_doctor_punch_result") {
    const pendingSuccess = gameState.pendingDoctorPunchSuccess || null;
    if (pendingSuccess && pendingSuccess.playerId) {
      const playersObj = roomData.players || {};
      const successPlayerId = pendingSuccess.playerId;
      const successPlayer = playersObj[successPlayerId];
      const successPlayerName = successPlayer?.name || pendingSuccess?.playerName || "プレイヤー";

      const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
      const stateKey = `${roomId || "no-room"}:${gameState.turn || ""}:${gameState.currentPlayerIndex || ""}:${gameState.pendingDoctorPunchProceed ? "proceed" : ""}:${gameState.pendingLastPlayerResult ? "last" : ""}:${successPlayerId}`;
      if (stateKey !== lastDoctorPunchStateLogKey) {
        lastDoctorPunchStateLogKey = stateKey;
        console.log("[DoctorPunch] state", {
          roomId,
          turn: gameState.turn,
          subphase: gameState.subphase,
          currentPlayerIndex: gameState.currentPlayerIndex,
          pendingDoctorPunchProceed: gameState.pendingDoctorPunchProceed,
          pendingLastPlayerResult: gameState.pendingLastPlayerResult,
          pendingDoctorPunchSuccess: pendingSuccess,
        });
      }
      
      // 重複防止：同じプレイヤーの成功ポップアップが既に表示されている場合はスキップ
      const order = GameState.playerOrder || Object.keys(playersObj);
      const successPlayerIndex = order.indexOf(successPlayerId);
      const previousSubphase = typeof window !== "undefined" ? window.__previousSubphase : null;
      if (lastSuccessAnnouncementPlayerIndex === successPlayerIndex && previousSubphase === "await_doctor_punch_result") {
        // 既に表示済みの場合はスキップ
      } else {
        // 表示前に即座にフラグをセット（二重表示防止）
        lastSuccessAnnouncementPlayerIndex = successPlayerIndex;
        if (typeof window !== "undefined") {
          window.__previousSubphase = GameState.subphase;
        }
        
        // 成功ポップアップを表示（GM画面のみ）
        // 人狼妨害と同様に「GMのOK操作」で進行する（自動タイマー進行はしない）
        showAnnouncement(
          `${successPlayerName}の失敗はドクター神拳により打ち消されました。`,
          null,
          `${successPlayerName}の挑戦：× → 神拳で打ち消し`,
          0,
          true,
          false,
          true, // GM画面のみ
          async () => {
            if (!roomId) return;
            if (gameState.pendingLastPlayerResult === true) {
              await endTurnAfterLastPlayerResultDB(roomId);
            } else {
              await proceedToNextPlayerAfterDoctorPunchDB(roomId);
            }
          }
        );
      }
    }
  }
  
  if (gameState.turnResult && gameState.turnResult !== lastTurnResult) {
    lastTurnResult = gameState.turnResult;
    // ターン結果を表示する際のターン番号（次のターンに進む前に保存された値）
    const turn = gameState.turnResultTurn || GameState.turn || 1;
    const pendingFinalPhase = gameState.pendingFinalPhaseExplanation === true;
    
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
          // ターン結果ポップアップが閉じた後、最終フェーズ説明ポップアップまたは会議フェーズを開始
          const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
          if (roomId) {
            try {
              if (pendingFinalPhase) {
                // 最終フェーズに突入する場合、turnResultをクリアしてから最終フェーズ説明ポップアップを表示
                const roomRef = doc(firestore, "rooms", roomId);
                await updateDoc(roomRef, {
                  "gameState.turnResult": null, // ターン結果をクリア（最終フェーズ説明ポップアップの表示条件を満たすため）
                });
                // pendingFinalPhaseExplanationフラグは既に設定されているので、次回のsyncGameStateFromFirebaseで表示される
              } else {
                // 会議フェーズを開始（discussionPhaseをtrueに設定）
                const roomRef = doc(firestore, "rooms", roomId);
                await updateDoc(roomRef, {
                  "gameState.discussionPhase": true,
                });
              }
            } catch (e) {
              console.error("Failed to start discussion phase or final phase:", e);
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
          // ターン結果ポップアップが閉じた後、最終フェーズ説明ポップアップまたは会議フェーズを開始
          const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
          if (roomId) {
            try {
              if (pendingFinalPhase) {
                // 最終フェーズに突入する場合、turnResultをクリアしてから最終フェーズ説明ポップアップを表示
                const roomRef = doc(firestore, "rooms", roomId);
                await updateDoc(roomRef, {
                  "gameState.turnResult": null, // ターン結果をクリア（最終フェーズ説明ポップアップの表示条件を満たすため）
                });
                // pendingFinalPhaseExplanationフラグは既に設定されているので、次回のsyncGameStateFromFirebaseで表示される
              } else {
                // 会議フェーズを開始（discussionPhaseをtrueに設定）
                const roomRef = doc(firestore, "rooms", roomId);
                await updateDoc(roomRef, {
                  "gameState.discussionPhase": true,
                });
              }
            } catch (e) {
              console.error("Failed to start discussion phase or final phase:", e);
            }
          }
        }
      );
    }
    
    // ターン結果をクリア（最終フェーズに突入する場合は後でクリア）
    const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    if (roomId) {
      // 通常ターン：2秒後にクリア
      if (!pendingFinalPhase) {
        setTimeout(async () => {
          try {
            await syncToFirebase("clearTurnResult", { roomId });
          } catch (e) {
            console.error("Failed to clear turn result:", e);
          }
        }, 2000);
      } else {
        // 最終フェーズ突入時：onOk内のupdateDocが失敗すると turnResult が残り続けてデッドロックするため、
        // フォールバックでもクリアしておく（同一更新が重複しても問題なし）
        setTimeout(async () => {
          try {
            const roomRef = doc(firestore, "rooms", roomId);
            await updateDoc(roomRef, { "gameState.turnResult": null });
          } catch (e) {
            console.error("Failed to clear turn result (final phase fallback):", e);
          }
        }, 2500);
      }
    }
  } else if (!gameState.turnResult) {
    lastTurnResult = null; // ターン結果がクリアされたらリセット
  }
  
  // 前回の会議フェーズ状態を更新（ターン結果表示後に会議フェーズを処理するため）
  previousDiscussionPhase = currentDiscussionPhase;
  
  // ターン切り替え時のポップアップを表示（1ターン目も含む）
  if (previousTurn !== currentTurn && GameState.phase === "playing") {
    // ターンが変わった時は重複防止フラグをリセット
    lastSuccessAnnouncementPlayerIndex = null;
    lastFailAnnouncementPlayerIndex = null;
    lastChallengeAnnouncementPlayerIndex = null;
    if (typeof window !== "undefined") {
      window.__previousSubphase = null;
    }
    
    // ターンに応じたUI変化を適用
    if (typeof document !== "undefined") {
      const body = document.body;
      const app = document.getElementById("app");
      const mainScreen = document.getElementById("main-screen");
      const participantScreen = document.getElementById("participant-screen");
      
      // ターンに応じたクラスを削除
      body.classList.remove("turn-1", "turn-2", "turn-3", "turn-4", "turn-5");
      if (app) app.classList.remove("turn-1", "turn-2", "turn-3", "turn-4", "turn-5");
      if (mainScreen) mainScreen.classList.remove("turn-1", "turn-2", "turn-3", "turn-4", "turn-5");
      if (participantScreen) participantScreen.classList.remove("turn-1", "turn-2", "turn-3", "turn-4", "turn-5");
      
      // 現在のターンに応じたクラスを追加
      const turnClass = `turn-${currentTurn}`;
      body.classList.add(turnClass);
      if (app) app.classList.add(turnClass);
      if (mainScreen) mainScreen.classList.add(turnClass);
      if (participantScreen) participantScreen.classList.add(turnClass);
    }
    
    showAnnouncement(
      `${currentTurn}ターン目`,
      null,
      `${currentTurn}ターン目開始`,
      2000,
      false,
      false,
      true // GM画面のみ
    );
    previousTurn = currentTurn; // 更新を記録
  }
  
  // pendingNextPlayerChallengeフラグが立っている場合、次のプレイヤーの挑戦開始フェーズに移行
  if (GameState.phase === "playing" && gameState.pendingNextPlayerChallenge && GameState.subphase === "await_result") {
    const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    if (roomId) {
      setTimeout(async () => {
        try {
          await proceedToNextPlayerChallengeDB(roomId);
        } catch (e) {
          console.error("Failed to proceed to next player challenge:", e);
        }
      }, 100);
    }
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
          myRole === "wolf" ? "レユニオン" : myRole === "doctor" ? "ドクター" : "オペレーター";
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

      // ドクター操作中（妨害と同様の「継続表示」）
      // ただし、他のポップアップを邪魔しないように「キューが空」の時だけ表示する
      if (gameState.subphase === "await_doctor" && isAnnouncementQueueEmpty()) {
        showAnnouncement("ドクターが操作中です。", null, null, 0, false, false, true);
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

    // GM画面：10分タイマーと結果開示ボタンを表示
    if (isGM) {
      showFinalPhaseGMModal(roomData);
    }
    
    // 全プレイヤー（市民・ドクター・人狼）：人狼投票モーダルを表示
    if (myRole) {
      showFinalPhaseModal(roomData);
    } else if (!isGM) {
      // その他の参加者（役職なし）：待機画面を表示
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

  // 会議フェーズの処理（final_phaseの時はスキップ）
  if (phase !== "final_phase") {
    handleDiscussionPhase(roomData);
  }
  
  // 最終フェーズ説明ポップアップの表示
  // - turnResult のクリアが失敗するとデッドロックするため、turnResult の有無ではブロックしない
  // - キューが空の時のみ表示
  if (gameState.pendingFinalPhaseExplanation && phase === "playing" && isAnnouncementQueueEmpty()) {
    const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
    const myId = typeof window !== "undefined" ? window.__uid : null;
    const isGM = !!(createdBy && myId && createdBy === myId);
    const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    const key = `${roomId || "no-room"}:${gameState.turn || ""}:final_explain`;
    
    // GM画面のみ表示
    if (isGM && roomId && key !== lastFinalPhaseExplanationKey) {
      lastFinalPhaseExplanationKey = key;
      showAnnouncement(
        "最終フェーズ（逆転指名）",
        "全プレイヤーがレユニオンを指名します。全員が投票した時点で、一番被投票数の多いプレイヤーが1人だけ（同率1位ではない）の場合、そのプレイヤーがレユニオンかどうかで勝敗が決まります。",
        "最終フェーズ開始",
        0,
        true, // OKボタンを要求
        false,
        true, // GM画面のみ
        async () => {
          // OKボタンを押した後に最終フェーズに進む
          try {
            const roomRef = doc(firestore, "rooms", roomId);
            // 10分のタイマーを開始
            const endTime = Date.now() + 10 * 60 * 1000;
            await updateDoc(roomRef, {
              "gameState.phase": "final_phase",
              "gameState.finalPhaseVotes": {},
              "gameState.finalPhaseVoteCounts": null,
              "gameState.pendingFinalPhaseExplanation": null,
              "gameState.turnResult": null, // ターン結果をクリア（最終フェーズに進むため）
              "gameState.finalPhaseDiscussionEndTime": endTime, // 10分タイマーの終了時刻
              "gameState.subphase": null,
            });
          } catch (e) {
            console.error("Failed to proceed to final phase:", e);
          }
        }
      );
    }
  }
}

/**
 * 会議フェーズのUI管理とタイマー更新
 */
function handleDiscussionPhase(roomData) {
  const gameState = roomData.gameState || {};
  const phase = gameState.phase || "waiting";
  
  // final_phaseの時は処理しない（showFinalPhaseGMModalで処理される）
  if (phase === "final_phase") {
    return;
  }
  
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
    true, // GM画面のみ
    async () => {
      // ポップアップが閉じた後に通知をクリア（このタイミングでターン終了処理が走る）
      const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
      if (roomId) {
        syncToFirebase("clearDoctorSkipNotification", { roomId }).catch((e) => {
          console.error("Failed to clear doctor skip notification:", e);
        });
      }
    }
  );

  // 通知クリアは onOk（autoClose 後）に移動した
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
        role === "wolf" ? "レユニオン" : role === "doctor" ? "ドクター" : "オペレーター";
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
  const name = data?.playerName || "プレイヤー";
  await applySuccessDB(roomId);
  
  // ルームの状態を確認して、最後のプレイヤーかどうかを判定
  const roomRef = doc(firestore, "rooms", roomId);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return;
  
  const roomData = snap.data();
  const gameState = roomData?.gameState || {};
  const isLastPlayer = gameState.pendingLastPlayerResult === true;
  
  // 挑戦結果アナウンス（GM画面のみ）
  // ポップアップが閉じた後に次のプレイヤーの挑戦開始フェーズに移行、またはターン終了処理を実行
  showAnnouncement(
    `${name}の挑戦は成功しました。`,
    null,
    `${name}の挑戦：〇`,
    2000,
    false,
    false,
    true, // GM画面のみ
    async () => {
      // 最後のプレイヤーの場合、ターン終了処理を実行
      if (isLastPlayer) {
        const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
        if (roomId) {
          try {
            // ターン終了処理を実行（成功として）
            await endTurnAfterLastPlayerResultDB(roomId);
          } catch (e) {
            console.error("Failed to end turn:", e);
          }
        }
      } else {
        // 最後のプレイヤーでない場合、次のプレイヤーの挑戦開始フェーズに移行
        const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
        if (roomId) {
          try {
            await proceedToNextPlayerChallengeDB(roomId);
          } catch (e) {
            console.error("Failed to proceed to next player challenge:", e);
          }
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

  
  // applyFailの結果を確認（ルームの状態を取得）
  const roomRef = doc(firestore, "rooms", roomId);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return;
  
  const roomData = snap.data();
  const gameState = roomData?.gameState || {};
  const subphase = gameState.subphase;
  
  // 挑戦結果アナウンス
  // isConfirmがtrueの場合、またはsubphaseがawait_doctorでない場合（神拳が使えない場合）はポップアップを表示
  if (isConfirm || subphase !== "await_doctor") {
    // 神拳が残っていない、または失敗確定
    showAnnouncement(
      `${name}の挑戦は失敗しました。`,
      isConfirm ? "ドクター神拳が残っていないため、強制的に失敗となります。" : null,
        `${name}の挑戦：×`,
        2000,
      false,
      false,
      true, // GM画面のみ
      async () => {
        // 挑戦結果ポップアップが閉じた後、次のプレイヤーの挑戦開始フェーズに移行
        // ただし、ターン終了処理が実行された場合は何もしない
        const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
        if (roomId) {
          try {
            // ルームの状態を確認してから処理
            const roomRef = doc(firestore, "rooms", roomId);
            const snap = await getDoc(roomRef);
            if (snap.exists()) {
              const roomData = snap.data();
              // ターン終了処理が実行されていない場合（subphaseがawait_resultのまま）のみ処理
              if (roomData?.gameState?.phase === "playing" && roomData?.gameState?.pendingNextPlayerChallenge) {
                await proceedToNextPlayerChallengeDB(roomId);
              }
            }
          } catch (e) {
            console.error("Failed to proceed to next player challenge:", e);
          }
        }
      }
    );
  }
  // subphaseがawait_doctorになった場合は、ドクターが操作中ポップアップが表示される（handlePhaseUIで処理）
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
  // DB側での処理（subphaseをawait_doctor_punch_resultに変更）のみ実行
  // ポップアップ表示はsyncGameStateFromFirebase側での検知に任せる
  try {
    const gs = typeof window !== "undefined" ? window.GameState : null;
    console.log("[DoctorPunch] click", {
      roomId,
      subphase: gs?.subphase,
      pendingFailure: gs?.pendingFailure,
      doctorPunchRemaining: gs?.doctorPunchRemaining,
      doctorPunchAvailableThisTurn: gs?.doctorPunchAvailableThisTurn,
    });
    await applyDoctorPunchDB(roomId);
    console.log("[DoctorPunch] applyDoctorPunchDB success", { roomId });
  } catch (e) {
    console.error("Failed to apply doctor punch:", e);
  }
}

/**
 * 人狼妨害アクションの処理
 */
async function handleWolfActionAction(data, roomId) {
  const userId = getCurrentUserId();
  await applyWolfActionDB(roomId);
  // 乱数結果を保存（既にクライアント側で選択済み）
  await saveRandomResult(roomId, `wolfAction_${Date.now()}`, { action: data.action, timestamp: Date.now() });
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
  
  // ステージ結果アナウンス（GM画面のみ）
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

  titleEl.textContent = "最終判定: レユニオン投票フェーズ";
  summaryEl.textContent = "全プレイヤーがレユニオンを指名します。全員が投票した時点で、一番被投票数の多いプレイヤーが1人だけ（同率1位ではない）の場合、そのプレイヤーがレユニオンかどうかで勝敗が決まります。";

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
  
  // 10分タイマーを表示
  const discussionEndTime = gameState.finalPhaseDiscussionEndTime || null;
  if (discussionEndTime) {
    const timerContainer = document.createElement("div");
    timerContainer.style.textAlign = "center";
    timerContainer.style.marginBottom = "20px";
    timerContainer.style.padding = "16px";
    timerContainer.style.background = "rgba(139, 230, 195, 0.1)";
    timerContainer.style.borderRadius = "8px";
    timerContainer.style.border = "1px solid rgba(139, 230, 195, 0.3)";
    
    const timerLabel = document.createElement("div");
    timerLabel.textContent = "残り時間";
    timerLabel.style.fontSize = "14px";
    timerLabel.style.color = "#a0a4ba";
    timerLabel.style.marginBottom = "8px";
    timerContainer.appendChild(timerLabel);
    
    const timerEl = document.createElement("div");
    timerEl.id = "final-phase-guest-timer";
    timerEl.style.fontSize = "32px";
    timerEl.style.fontWeight = "700";
    timerEl.style.color = "#8be6c3";
    timerEl.style.letterSpacing = "0.1em";
    timerContainer.appendChild(timerEl);
    
    extraEl.appendChild(timerContainer);
    
    // タイマーを更新
    updateFinalPhaseTimer(timerEl, discussionEndTime);
    
    // タイマーを定期的に更新
    if (finalPhaseGuestTimerInterval) {
      clearInterval(finalPhaseGuestTimerInterval);
    }
    finalPhaseGuestTimerInterval = setInterval(() => {
      const currentTimerEl = document.getElementById("final-phase-guest-timer");
      if (currentTimerEl) {
        updateFinalPhaseTimer(currentTimerEl, discussionEndTime);
      } else {
        clearInterval(finalPhaseGuestTimerInterval);
        finalPhaseGuestTimerInterval = null;
      }
    }, 1000);
  }
  
  // 投票状況を表示（全プレイヤーをカウント）
  const voteInfo = document.createElement("p");
  const voters = playersArr; // 全プレイヤー（人狼も含む）
  const votedCount = Object.keys(votes).length;
  const voterCount = voters.length;
  voteInfo.textContent = `投票状況: ${votedCount}/${voterCount}人`;
  voteInfo.style.marginBottom = "12px";
  voteInfo.style.color = "#a0a4ba";
  extraEl.appendChild(voteInfo);

  if (!hasVoted) {
    const info = document.createElement("p");
    info.textContent = "レユニオンだと思うプレイヤーを1名選択してください。";
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
            // 投票後もモーダルを閉じない（全員が投票するまで開いたまま）
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
  
  // 全員が投票した場合、ゲストUIの投票画面を非表示にする
  const allVoted = votedCount === voterCount;
  if (allVoted) {
    // 全員投票完了後、ゲストUIの投票画面を非表示にする
    modal.classList.add("hidden");
  }
  
  // モーダルを表示（投票後も閉じない、ただし全員投票完了後は非表示）
  if (!allVoted) {
    modal.classList.remove("hidden");
  }
}

/**
 * 最終フェーズ：タイマーを更新
 */
function updateFinalPhaseTimer(timerEl, discussionEndTime) {
  if (!timerEl || !discussionEndTime) return;
  
  const now = Date.now();
  const remaining = Math.max(0, discussionEndTime - now);
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  const timeString = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  
  timerEl.textContent = timeString;
  
  // タイマーが0になった場合、自動で最終フェーズを終了（投票が完了していない場合でも）
  if (remaining <= 0) {
    if (finalPhaseTimerInterval) {
      clearInterval(finalPhaseTimerInterval);
      finalPhaseTimerInterval = null;
    }
    // タイマーが0になった場合の処理は必要に応じて実装
  }
}

/**
 * 最終フェーズ：GM画面に10分タイマーと結果開示ボタンを表示
 */
let lastFinalPhaseGMModalTimestamp = null;
let finalPhaseTimerInterval = null;
let finalPhaseGuestTimerInterval = null;

function showFinalPhaseGMModal(roomData) {
  console.log("[showFinalPhaseGMModal] Called", roomData);
  const modal = document.getElementById("discussion-modal");
  const timerEl = document.getElementById("discussion-timer");
  const titleEl = modal?.querySelector("h2");
  const summaryEl = modal?.querySelector("p");
  const actionsEl = modal?.querySelector(".modal-actions");
  
  console.log("[showFinalPhaseGMModal] Elements:", { modal, timerEl, titleEl, actionsEl });
  if (!modal || !timerEl || !titleEl || !actionsEl) {
    console.error("[showFinalPhaseGMModal] Missing required elements");
    return;
  }

  const gameState = roomData.gameState || {};
  const votes = gameState.finalPhaseVotes || {};
  const discussionEndTime = gameState.finalPhaseDiscussionEndTime || null;
  const votesTimestamp = JSON.stringify(votes);
  
  // 投票データが更新された場合のみ再描画（ただし、discussionEndTimeが設定されている場合のみ）
  if (votesTimestamp === lastFinalPhaseGMModalTimestamp && !modal.classList.contains("hidden") && discussionEndTime) {
    // タイマーのみ更新
    updateFinalPhaseTimer(timerEl, discussionEndTime);
    return;
  }
  // discussionEndTimeが設定されていない場合は、タイマーを表示しない（説明ポップアップのOK押下待ち）
  if (!discussionEndTime) {
    console.log("[showFinalPhaseGMModal] discussionEndTime not set yet, waiting for explanation popup OK");
    return;
  }
  lastFinalPhaseGMModalTimestamp = votesTimestamp;

  const playersObj = roomData.players || {};
  const playersArr = Object.entries(playersObj).map(([id, data]) => ({
    id,
    name: data.name,
    role: data.role,
  }));

  const votedCount = Object.keys(votes).length;
  const voterCount = playersArr.length;
  const allVoted = votedCount === voterCount;

  // タイトルと説明を設定
  titleEl.textContent = "最終フェーズ（逆転指名）";
  if (summaryEl) {
    summaryEl.textContent = `全プレイヤーがレユニオンを指名します。投票状況: ${votedCount}/${voterCount}人`;
  }

  // タイマーを更新
  if (discussionEndTime) {
    updateFinalPhaseTimer(timerEl, discussionEndTime);
    
    // タイマーを定期的に更新
    if (finalPhaseTimerInterval) {
      clearInterval(finalPhaseTimerInterval);
    }
    finalPhaseTimerInterval = setInterval(() => {
      updateFinalPhaseTimer(timerEl, discussionEndTime);
    }, 1000);
  }

  // アクションボタンを設定
  actionsEl.innerHTML = "";
  
  if (allVoted) {
    // 全員投票完了後、結果開示ボタンをアクティブに
    const resultBtn = document.createElement("button");
    resultBtn.className = "btn primary";
    resultBtn.textContent = "結果を開示";
      resultBtn.addEventListener("click", async () => {
      // 投票結果を計算してFirestoreに保存
      const voteCounts = {};
      Object.values(votes).forEach(votedPlayerId => {
        voteCounts[votedPlayerId] = (voteCounts[votedPlayerId] || 0) + 1;
      });
      
      // 最多得票者を特定
      let maxVotes = 0;
      let mostVotedPlayerId = null;
      let isTie = false;
      Object.entries(voteCounts).forEach(([playerId, count]) => {
        if (count > maxVotes) {
          maxVotes = count;
          mostVotedPlayerId = playerId;
          isTie = false;
        } else if (count === maxVotes) {
          isTie = true;
        }
      });
      
      // 結果を確定してFirestoreに保存
      const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
      if (roomId) {
        try {
          const roomRef = doc(firestore, "rooms", roomId);
          if (mostVotedPlayerId && !isTie) {
            // 最多得票者が1人だけの場合、そのプレイヤーがレユニオンかどうかで勝敗が決まる
            const suspectedPlayer = playersArr.find(p => p.id === mostVotedPlayerId);
            const isWolf = suspectedPlayer?.role === "wolf";
            await updateDoc(roomRef, {
              "gameState.phase": "finished",
              "gameState.gameResult": isWolf ? "citizen_win_reverse" : "wolf_win",
              "gameState.finalPhaseVoteCounts": voteCounts, // 投票数を保存
            });
            // 結果画面はshowGameResultで表示される（phaseがfinishedになった時に自動的に呼ばれる）
          } else {
            // 同率1位の場合はレユニオン勝利
            await updateDoc(roomRef, {
              "gameState.phase": "finished",
              "gameState.gameResult": "wolf_win",
              "gameState.finalPhaseVoteCounts": voteCounts, // 投票数を保存
            });
            // 結果画面はshowGameResultで表示される（phaseがfinishedになった時に自動的に呼ばれる）
          }
        } catch (e) {
          console.error("Failed to finalize vote result:", e);
          alert("結果の確定に失敗しました。");
          return;
        }
      }
    });
    actionsEl.appendChild(resultBtn);
  } else {
    // 全員投票完了前は、結果開示ボタンを非アクティブ状態で表示
    const resultBtn = document.createElement("button");
    resultBtn.className = "btn primary";
    resultBtn.textContent = "結果を開示";
    resultBtn.disabled = true;
    resultBtn.style.opacity = "0.5";
    resultBtn.style.cursor = "not-allowed";
    actionsEl.appendChild(resultBtn);
  }
  
  // モーダルを表示
  modal.classList.remove("hidden");
}

/**
 * ゲーム結果を表示（専用画面に遷移）
 */
function showGameResult(roomData, gameResult) {
  const victoryScreen = document.getElementById("victory-screen");
  const titleEl = document.getElementById("victory-title");
  const storyEl = document.getElementById("victory-story");
  const voteResultsEl = document.getElementById("victory-vote-results");
  const rolesEl = document.getElementById("victory-roles");
  
  if (!victoryScreen || !titleEl || !storyEl || !rolesEl) return;

  const playersObj = roomData.players || {};
  const playersArr = Object.entries(playersObj).map(([id, data]) => ({
    id,
    name: data.name,
    role: data.role,
  }));

  const gameState = roomData.gameState || {};
  
  // 他の画面を非表示
  const allScreens = document.querySelectorAll(".screen");
  allScreens.forEach(screen => screen.classList.remove("active"));
  
  // 勝利画面を表示
  victoryScreen.classList.add("active");
  
  // 背景色を設定
  if (gameResult === "citizen_win" || gameResult === "citizen_win_reverse") {
    // ロドス陣営の勝利：青系統
    victoryScreen.classList.remove("victory-wolf");
    victoryScreen.classList.add("victory-citizen");
    document.body.classList.remove("victory-wolf-bg");
    document.body.classList.add("victory-citizen-bg");
  } else if (gameResult === "wolf_win") {
    // レユニオンの勝利：赤系統
    victoryScreen.classList.remove("victory-citizen");
    victoryScreen.classList.add("victory-wolf");
    document.body.classList.remove("victory-citizen-bg");
    document.body.classList.add("victory-wolf-bg");
  }

  // ゲーム結果に応じてタイトルとストーリーを設定
  if (gameResult === "citizen_win") {
    titleEl.textContent = "ロドス陣営の勝利";
    storyEl.innerHTML = `
      <p>作戦は成功した。全ての任務を完遂し、ロドスは勝利を収めた。</p>
      <p>隊員たちの結束と努力が、この結果をもたらしたのだ。</p>
      <p>しかし、この勝利の裏には、多くの犠牲と困難があったことも忘れてはならない。</p>
    `;
  } else if (gameResult === "citizen_win_reverse") {
    titleEl.textContent = "ロドス陣営の勝利（逆転）";
    storyEl.innerHTML = `
      <p>危機的状況の中、隊員たちは真実を見抜いた。</p>
      <p>潜伏していた敵対勢力を特定し、逆転の勝利を手にした。</p>
      <p>この勝利は、隊員たちの洞察力と結束の証である。</p>
    `;
  } else if (gameResult === "wolf_win") {
    titleEl.textContent = "レユニオンの勝利";
    if (gameState.doctorHasFailed) {
      storyEl.innerHTML = `
        <p>ドクターの失敗が、作戦の命運を決した。</p>
        <p>レユニオンの策略により、ロドスは敗北を喫した。</p>
        <p>この結果は、内部に潜む敵対勢力の勝利を意味する。</p>
      `;
    } else {
      storyEl.innerHTML = `
        <p>作戦は失敗に終わった。×が過半数を占め、ロドスは敗北した。</p>
        <p>レユニオンの策略が功を奏し、隊員たちは力を失った。</p>
        <p>この敗北は、今後の作戦に大きな影響を与えるだろう。</p>
      `;
    }
  }

  // 最終フェーズの投票結果を表示
  const voteCounts = gameState.finalPhaseVoteCounts || {};
  if (Object.keys(voteCounts).length > 0) {
    voteResultsEl.innerHTML = "";
    const voteResultTitle = document.createElement("h3");
    voteResultTitle.textContent = "投票結果";
    voteResultTitle.style.marginTop = "20px";
    voteResultTitle.style.marginBottom = "12px";
    voteResultTitle.style.color = "#f5f5f7";
    voteResultTitle.style.fontSize = "18px";
    voteResultsEl.appendChild(voteResultTitle);
    
    // 投票数を降順でソート
    const sortedVotes = Object.entries(voteCounts)
      .map(([playerId, count]) => {
        const player = playersArr.find(p => p.id === playerId);
        return { playerId, playerName: player?.name || "不明", count };
      })
      .sort((a, b) => b.count - a.count);
    
    const totalVotes = Object.values(voteCounts).reduce((sum, count) => sum + count, 0);
    
    // 円グラフコンテナ
    const chartContainer = document.createElement("div");
    chartContainer.style.display = "flex";
    chartContainer.style.flexDirection = "column";
    chartContainer.style.alignItems = "center";
    chartContainer.style.gap = "20px";
    chartContainer.style.marginTop = "20px";
    
    // 円グラフSVG
    const svgSize = 200;
    const radius = svgSize / 2 - 10;
    const centerX = svgSize / 2;
    const centerY = svgSize / 2;
    
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", svgSize);
    svg.setAttribute("height", svgSize);
    svg.style.transform = "rotate(-90deg)";
    svg.style.borderRadius = "50%";
    
    // 色のパレット
    const colors = [
      "#8be6c3",
      "#7dd3fc",
      "#a78bfa",
      "#f472b6",
      "#fb923c",
      "#fbbf24",
      "#34d399",
      "#60a5fa"
    ];
    
    let currentAngle = 0;
    sortedVotes.forEach(({ playerName, count }, index) => {
      const percentage = (count / totalVotes) * 100;
      const angle = (percentage / 100) * 360;
      const largeArcFlag = angle > 180 ? 1 : 0;
      
      const startAngle = currentAngle;
      const endAngle = currentAngle + angle;
      
      const startX = centerX + radius * Math.cos((startAngle * Math.PI) / 180);
      const startY = centerY + radius * Math.sin((startAngle * Math.PI) / 180);
      const endX = centerX + radius * Math.cos((endAngle * Math.PI) / 180);
      const endY = centerY + radius * Math.sin((endAngle * Math.PI) / 180);
      
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const pathData = `M ${centerX} ${centerY} L ${startX} ${startY} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${endX} ${endY} Z`;
      path.setAttribute("d", pathData);
      path.setAttribute("fill", colors[index % colors.length]);
      path.setAttribute("opacity", "0.8");
      path.style.transition = "opacity 0.2s ease";
      path.style.cursor = "pointer";
      
      path.addEventListener("mouseenter", () => {
        path.setAttribute("opacity", "1");
      });
      path.addEventListener("mouseleave", () => {
        path.setAttribute("opacity", "0.8");
      });
      
      svg.appendChild(path);
      currentAngle += angle;
    });
    
    chartContainer.appendChild(svg);
    
    // 凡例
    const legend = document.createElement("div");
    legend.style.display = "flex";
    legend.style.flexDirection = "column";
    legend.style.gap = "8px";
    legend.style.width = "100%";
    legend.style.marginTop = "10px";
    
    sortedVotes.forEach(({ playerName, count }, index) => {
      const percentage = (count / totalVotes) * 100;
      const legendItem = document.createElement("div");
      legendItem.style.display = "flex";
      legendItem.style.alignItems = "center";
      legendItem.style.justifyContent = "space-between";
      legendItem.style.padding = "8px 12px";
      legendItem.style.borderRadius = "6px";
      legendItem.style.background = "rgba(255, 255, 255, 0.05)";
      legendItem.style.border = `2px solid ${colors[index % colors.length]}`;
      legendItem.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 16px; height: 16px; border-radius: 4px; background: ${colors[index % colors.length]};"></div>
          <span style="font-weight: 500; color: #f5f5f7;">${playerName}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 14px; color: #a0a4ba;">${percentage.toFixed(1)}%</span>
          <span style="font-size: 18px; font-weight: 700; color: ${colors[index % colors.length]};">${count}票</span>
        </div>
      `;
      legend.appendChild(legendItem);
    });
    
    chartContainer.appendChild(legend);
    voteResultsEl.appendChild(chartContainer);
  } else {
    voteResultsEl.innerHTML = "";
  }

  // プレイヤー一覧を表示
  rolesEl.innerHTML = "";
  const rolesList = document.createElement("div");
  rolesList.className = "result-roles-list";
  rolesList.style.display = "flex";
  rolesList.style.flexDirection = "column";
  rolesList.style.gap = "8px";
  rolesList.style.marginTop = "20px";

  playersArr.forEach((p) => {
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
    roleItem.style.padding = "8px 12px";
    roleItem.style.borderRadius = "6px";
    roleItem.style.background = "rgba(255, 255, 255, 0.05)";
    roleItem.innerHTML = `
      <span style="font-weight: 500; color: #f5f5f7;">${p.name}</span>
      <span class="player-role-tag ${roleClass}" style="margin-left: auto;">${roleLabel}</span>
    `;
    rolesList.appendChild(roleItem);
  });

  rolesEl.appendChild(rolesList);
  
  // ボタンのイベントリスナーを設定
  setupVictoryScreenButtons(roomData);
}

/**
 * 勝利画面のボタンイベントリスナーを設定
 */
function setupVictoryScreenButtons(roomData) {
  const returnLobbyBtn = document.getElementById("victory-return-lobby");
  const disbandBtn = document.getElementById("victory-disband");
  
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
          const currentAcks = data?.gameState?.resultReturnLobbyAcks || {};
          const newAcks = { ...currentAcks, [userId]: true };
          
          // 既存のresultReturnLobbyAcksを取得（なければ空オブジェクト）
          const existingAcks = data?.gameState?.resultReturnLobbyAcks || {};
          
          // 最初のプレイヤーが「ロビーに戻る」を押した場合は、ゲーム状態をリセット
          const shouldResetGameState = Object.keys(existingAcks).length === 0;
          
          const updates = {
            "gameState.resultReturnLobbyAcks": newAcks,
          };
          
          if (shouldResetGameState) {
            // ゲーム状態をwaitingフェーズにリセット
            updates["gameState.phase"] = "waiting";
            updates["gameState.turn"] = 1;
            updates["gameState.whiteStars"] = 0;
            updates["gameState.blackStars"] = 0;
            updates["gameState.currentPlayerIndex"] = 0;
            updates["gameState.currentStage"] = null;
            updates["gameState.stageTurn"] = null;
            updates["gameState.subphase"] = null;
            updates["gameState.pendingFailure"] = null;
            updates["gameState.playerOrder"] = null;
            updates["gameState.wolfDecisionPlayerId"] = null;
            updates["gameState.wolfActionRequest"] = null;
            updates["gameState.gameResult"] = null;
            updates["gameState.discussionPhase"] = false;
            updates["gameState.discussionEndTime"] = null;
            updates["gameState.finalPhaseVotes"] = {};
            updates["gameState.finalPhaseVoteCounts"] = null;
            updates["gameState.finalPhaseDiscussionEndTime"] = null;
            updates["gameState.pendingFinalPhaseExplanation"] = null;
            updates["gameState.turnResult"] = null;
            updates["gameState.turnResultTurn"] = null;
            updates["gameState.doctorHasFailed"] = false;
            
            // resourcesもリセット
            const playersObj = data?.players || {};
            const playerIds = Object.keys(playersObj);
            playerIds.forEach((pid) => {
              const player = playersObj[pid];
              const role = player?.role;
              if (role === "wolf") {
                updates[`players.${pid}.resources.wolfActionsRemaining`] = 100;
              }
              if (role === "doctor") {
                updates[`players.${pid}.resources.doctorPunchRemaining`] = 5;
                updates[`players.${pid}.resources.doctorPunchAvailableThisTurn`] = true;
              }
            });
          }
          
          tx.update(roomRef, updates);
        });
        
        // 画面をロビー（waiting-screen）に戻す
        const victoryScreen = document.getElementById("victory-screen");
        const waiting = document.getElementById("waiting-screen");
        const main = document.getElementById("main-screen");
        const participant = document.getElementById("participant-screen");
        
        if (victoryScreen && victoryScreen.classList.contains("active")) {
          switchScreen("victory-screen", "waiting-screen");
        } else if (main && main.classList.contains("active")) {
          switchScreen("main-screen", "waiting-screen");
        } else if (participant && participant.classList.contains("active")) {
          switchScreen("participant-screen", "waiting-screen");
        } else {
          switchScreen("home-screen", "waiting-screen");
        }
      } catch (e) {
        console.error("Failed to return to lobby:", e);
        alert(e?.message || "ロビーに戻る処理に失敗しました。");
      }
    });
  }
  
  if (disbandBtn) {
    // 既存のイベントリスナーを削除してから追加
    const newBtn = disbandBtn.cloneNode(true);
    disbandBtn.parentNode.replaceChild(newBtn, disbandBtn);
    
    newBtn.addEventListener("click", async () => {
      const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
      if (!roomId) return;
      
      try {
        const userId = getCurrentUserId();
        if (!userId) {
          throw new Error("User not authenticated");
        }
        
        const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
        const isGM = !!(createdBy && userId && createdBy === userId);
        
        if (!isGM) {
          alert("GMのみがルームを解散できます。");
          return;
        }
        
        if (!confirm("ルームを解散してホームに戻りますか？")) {
          return;
        }
        
        // ルームを削除
        const roomRef = doc(firestore, "rooms", roomId);
        await updateDoc(roomRef, {
          "gameState.phase": "waiting",
        });
        
        // ホーム画面に戻る
        if (typeof window !== "undefined" && window.returnToHome) {
          window.returnToHome();
        }
      } catch (e) {
        console.error("Failed to disband room:", e);
        alert(e?.message || "ルームの解散に失敗しました。");
      }
    });
  }
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
