// Firebase同期処理
import { createRoom, joinRoom, subscribeToRoom, updateGameState, updatePlayerState, addLog, saveRandomResult } from "./firebase-db.js";
import { signInAnonymously, getCurrentUserId, getCurrentUser } from "./firebase-auth.js";
import { firestore } from "./firebase-config.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

let currentRoomId = null;
let roomUnsubscribe = null;
let isSyncing = false;

// グローバル変数として公開（main.jsからアクセス可能にする）
if (typeof window !== 'undefined') {
  window.getCurrentRoomId = () => currentRoomId;
  window.setCurrentRoomId = (id) => { currentRoomId = id; };
}

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
    const roomId = await createRoom({
      gmName: config.gmName || 'GM',
      maxPlayers: config.maxPlayers || 8,
      stageMinChapter: config.stageMinChapter,
      stageMaxChapter: config.stageMaxChapter,
      wolfActionTexts: config.wolfActionTexts,
    });
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
  const gameState = roomData.gameState;
  const players = roomData.players;
  const userId = getCurrentUserId();
  
  // ゲーム状態を同期
  GameState.turn = gameState.turn || 1;
  GameState.whiteStars = gameState.whiteStars || 0;
  GameState.blackStars = gameState.blackStars || 0;
  GameState.currentPlayerIndex = gameState.currentPlayerIndex || 0;
  GameState.currentStage = gameState.currentStage;
  
  // プレイヤー情報を同期
  GameState.players = Object.entries(players).map(([playerId, playerData]) => ({
    id: playerId,
    name: playerData.name,
    avatarLetter: playerData.name[0] || '?',
    avatarImage: playerData.avatarImage || null,
    role: playerData.role,
    resources: playerData.resources || {},
  }));
  
  // 自分のリソース情報を同期
  if (players[userId]) {
    const myResources = players[userId].resources || {};
    GameState.wolfActionsRemaining = myResources.wolfActionsRemaining || 5;
    GameState.doctorPunchRemaining = myResources.doctorPunchRemaining || 5;
    GameState.doctorPunchAvailableThisTurn = myResources.doctorPunchAvailableThisTurn !== false;
  }
  
  // UIを更新
  renderAll();
  
  // ログを同期
  if (roomData.logs && roomData.logs.length > 0) {
    syncLogs(roomData.logs);
  }
}

/**
 * ローカルの変更をFirebaseに送信
 */
async function syncToFirebase(action, data) {
  const roomId = data.roomId || currentRoomId;
  if (!roomId) {
    return;
  }
  
  try {
    switch (action) {
      case 'success':
        await handleSuccessAction(data, roomId);
        break;
      case 'fail':
        await handleFailAction(data, roomId);
        break;
      case 'doctorPunch':
        await handleDoctorPunchAction(data, roomId);
        break;
      case 'wolfAction':
        await handleWolfActionAction(data, roomId);
        break;
      case 'nextPlayer':
        await handleNextPlayerAction(roomId);
        break;
      case 'stageRoulette':
        await handleStageRouletteAction(data, roomId);
        break;
      default:
        console.warn('Unknown action:', action);
    }
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
  
  // 次のプレイヤーに進む
  const currentIndex = GameState.currentPlayerIndex;
  const nextIndex = (currentIndex + 1) % GameState.players.length;
  
  await updateGameState(roomId, {
    'gameState.currentPlayerIndex': nextIndex,
  });
  
  await addLog(roomId, {
    type: 'success',
    message: `${data.playerName} がステージ攻略に成功しました。`,
    playerId: userId,
  });
}

/**
 * 失敗アクションの処理
 */
async function handleFailAction(data, roomId) {
  const userId = getCurrentUserId();
  
  await addLog(roomId, {
    type: 'fail',
    message: `${data.playerName} がステージ攻略に失敗しました。`,
    playerId: userId,
  });
  
  // ドクター神拳が使用可能な場合は保留状態
  if (GameState.doctorPunchRemaining > 0) {
    await updateGameState(roomId, {
      'gameState.pendingFailure': {
        playerId: userId,
        playerIndex: data.playerIndex,
      },
    });
  } else {
    // 失敗が確定
    await confirmFailure(data, roomId);
  }
}

/**
 * ドクター神拳アクションの処理
 */
async function handleDoctorPunchAction(data, roomId) {
  const userId = getCurrentUserId();
  
  // リソースを消費
  await updatePlayerState(roomId, userId, {
    'resources.doctorPunchRemaining': GameState.doctorPunchRemaining - 1,
    'resources.doctorPunchAvailableThisTurn': false,
  });
  
  // 保留中の失敗を解除
  await updateGameState(roomId, {
    'gameState.pendingFailure': null,
  });
  
  await addLog(roomId, {
    type: 'doctorPunch',
    message: `ドクター神拳発動！ ${data.playerName} の失敗はなかったことになりました。`,
    playerId: userId,
  });
}

/**
 * 人狼妨害アクションの処理
 */
async function handleWolfActionAction(data, roomId) {
  const userId = getCurrentUserId();
  
  // 乱数結果を保存（既にクライアント側で選択済み）
  await saveRandomResult(roomId, `wolfAction_${Date.now()}`, {
    action: data.action,
    timestamp: Date.now(),
  });
  
  // リソースを消費
  await updatePlayerState(roomId, userId, {
    'resources.wolfActionsRemaining': GameState.wolfActionsRemaining - 1,
  });
  
  await addLog(roomId, {
    type: 'wolfAction',
    message: `人狼妨害: ${data.action} が発動されました。`,
    playerId: userId,
  });
}

/**
 * 次のプレイヤーアクションの処理
 */
async function handleNextPlayerAction(roomId) {
  const currentIndex = GameState.currentPlayerIndex;
  const nextIndex = (currentIndex + 1) % GameState.players.length;
  
  await updateGameState(roomId, {
    'gameState.currentPlayerIndex': nextIndex,
  });
}

/**
 * ステージルーレットアクションの処理
 */
async function handleStageRouletteAction(data, roomId) {
  // 乱数結果を保存（既にクライアント側で選択済み）
  await saveRandomResult(roomId, `stage_${GameState.turn}`, {
    stage: data.stage,
    turn: GameState.turn,
    timestamp: Date.now(),
  });
  
  await updateGameState(roomId, {
    'gameState.currentStage': data.stage,
  });
  
  await addLog(roomId, {
    type: 'stage',
    message: `ターン${GameState.turn}のステージ: ${data.stage}`,
  });
}

/**
 * 失敗を確定
 */
async function confirmFailure(data, roomId) {
  await updateGameState(roomId, {
    'gameState.blackStars': GameState.blackStars + 1,
    'gameState.pendingFailure': null,
  });
  
  await addLog(roomId, {
    type: 'fail',
    message: `${data.playerName} の失敗が確定しました。黒星が1つ追加されます。`,
  });
}

/**
 * ログを同期
 */
function syncLogs(logs) {
  const logListEl = $("#log-list");
  if (!logListEl) return;
  
  // 最新のログのみ表示（既存のログは保持）
  const existingLogs = logListEl.children.length;
  const newLogs = logs.slice(existingLogs);
  
  newLogs.forEach(log => {
    addLogEntry(log.type, log.message);
  });
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
export { createRoomAndStartGame, joinRoomAndSync, syncToFirebase, stopRoomSync };
