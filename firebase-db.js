// Firestoreデータベース操作
import { collection, doc, setDoc, getDoc, updateDoc, onSnapshot, serverTimestamp, arrayUnion, runTransaction } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
import { firestore } from "./firebase-config.js";
import { getCurrentUserId } from "./firebase-auth.js";

// GM機能を削除：全員が同等のプレイヤー

/**
 * ルームを作成（GM用）
 */
async function createRoom(roomConfig) {
  // 既に生成されたルームIDがある場合はそれを使用、なければ新規生成
  const roomId = roomConfig.roomId || generateRoomId();
  const userId = getCurrentUserId();
  
  console.log('createRoom called with roomId:', roomId, 'userId:', userId);
  
  if (!userId) {
    throw new Error('User not authenticated');
  }
  
  // Firestoreはundefinedを保存できないため、undefined値を取り除く
  const cleanedRoomConfig = Object.fromEntries(
    Object.entries(roomConfig || {}).filter(([, v]) => v !== undefined)
  );

  const roomData = {
    config: {
      ...cleanedRoomConfig,
      roomId, // 必ず実体のroomIdを保存（undefinedを避ける）
      createdBy: userId,
      createdAt: serverTimestamp(),
    },
    gameState: {
      turn: 1,
      maxTurns: 5,
      phase: 'waiting', // waiting | playing | finished
      currentStage: null,
      whiteStars: 0,
      blackStars: 0,
      currentPlayerIndex: 0,
      lock: null, // 排他制御用
    },
    players: {},
    logs: [],
    randomResults: {},
  };
  
  // ホスト（最初のプレイヤー）を追加
  roomData.players[userId] = {
    name: cleanedRoomConfig.hostName || 'プレイヤー',
    role: null, // 役職は後で割り当て
    status: 'ready',
    resources: {
      wolfActionsRemaining: 5,
      doctorPunchRemaining: 5,
      doctorPunchAvailableThisTurn: true,
    },
    isHost: true, // ホストフラグ（権限は同じ）
  };
  
  console.log('Setting room document...');
  try {
    await setDoc(doc(firestore, 'rooms', roomId), roomData);
    console.log('Room document set successfully');
  } catch (error) {
    console.error('Error setting room document:', error);
    throw error;
  }
  
  return roomId;
}

/**
 * ルームに参加
 */
async function joinRoom(roomId, playerName) {
  const userId = getCurrentUserId();
  
  if (!userId) {
    throw new Error('User not authenticated');
  }
  
  console.log('Attempting to join room:', roomId);
  console.log('User ID:', userId);
  
  const roomRef = doc(firestore, 'rooms', roomId);
  const roomDoc = await getDoc(roomRef);
  
  console.log('Room document exists:', roomDoc.exists());
  
  if (!roomDoc.exists()) {
    console.error('Room not found. Room ID:', roomId);
    console.error('Please check:');
    console.error('1. ルームIDが正しく入力されているか（大文字小文字を確認）');
    console.error('2. GMがルームを作成しているか');
    console.error('3. Firestoreにルームが存在するか');
    throw new Error(`ルームが見つかりません (Room ID: ${roomId})\n\n確認事項:\n1. ルームIDが正しく入力されているか\n2. GMがルームを作成しているか\n3. ルームIDが共有されているか`);
  }
  
  const roomData = roomDoc.data();
  
  // 既に参加している場合は更新のみ
  if (roomData.players[userId]) {
    await updateDoc(roomRef, {
      [`players.${userId}.name`]: playerName,
      [`players.${userId}.status`]: 'ready',
    });
  } else {
    // 新規参加
    await updateDoc(roomRef, {
      [`players.${userId}`]: {
        name: playerName,
        role: null,
        status: 'ready',
        resources: {
          wolfActionsRemaining: 5,
          doctorPunchRemaining: 5,
          doctorPunchAvailableThisTurn: true,
        },
        isHost: false,
      },
    });
  }
  
  // ホストかどうかを確認（権限は同じ）
  const isHost = roomData.config.createdBy === userId;
  
  return roomData;
}

/**
 * ルームIDを生成（6文字のランダム文字列）
 */
function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * ルームデータをリアルタイム監視
 */
function subscribeToRoom(roomId, callback) {
  return onSnapshot(doc(firestore, 'rooms', roomId), (docSnap) => {
    if (docSnap.exists()) {
      callback(docSnap.data());
    } else {
      callback(null);
    }
  }, (error) => {
    console.error('Room subscription error:', error);
    callback(null);
  });
}

/**
 * ゲーム状態を更新（システム依存：全員が更新可能）
 */
async function updateGameState(roomId, updates) {
  const updatesWithTimestamp = {
    ...updates,
    'gameState.updatedAt': serverTimestamp(),
  };
  
  await updateDoc(doc(firestore, 'rooms', roomId), updatesWithTimestamp);
}

/**
 * プレイヤー状態を更新
 */
async function updatePlayerState(roomId, userId, updates) {
  const currentUserId = getCurrentUserId();
  
  // 自分のデータのみ更新可能
  if (userId !== currentUserId) {
    throw new Error('Cannot update other player\'s state');
  }
  
  const updateData = {};
  Object.keys(updates).forEach(key => {
    updateData[`players.${userId}.${key}`] = updates[key];
  });
  
  await updateDoc(doc(firestore, 'rooms', roomId), updateData);
}

/**
 * ログを追加
 */
async function addLog(roomId, logEntry) {
  const logData = {
    ...logEntry,
    timestamp: serverTimestamp(),
    userId: getCurrentUserId(),
  };
  
  await updateDoc(doc(firestore, 'rooms', roomId), {
    logs: arrayUnion(logData),
  });
}

/**
 * 乱数結果を保存
 */
async function saveRandomResult(roomId, key, value) {
  await updateDoc(doc(firestore, 'rooms', roomId), {
    [`randomResults.${key}`]: value,
  });
}

/**
 * 排他制御：ロックを取得
 */
async function acquireLock(roomId, lockType) {
  const roomRef = doc(firestore, 'rooms', roomId);
  const roomDoc = await getDoc(roomRef);
  const roomData = roomDoc.data();
  
  // 既にロックされている場合は失敗
  if (roomData.gameState.lock && roomData.gameState.lock.userId !== getCurrentUserId()) {
    return false;
  }
  
  // ロックを取得
  await updateDoc(roomRef, {
    'gameState.lock': {
      userId: getCurrentUserId(),
      type: lockType,
      timestamp: serverTimestamp(),
    },
  });
  
  return true;
}

/**
 * 排他制御：ロックを解放
 */
async function releaseLock(roomId) {
  await updateDoc(doc(firestore, 'rooms', roomId), {
    'gameState.lock': null,
  });
}

// エクスポート
export { createRoom, joinRoom, generateRoomId, subscribeToRoom, updateGameState, updatePlayerState, addLog, saveRandomResult, acquireLock, releaseLock, startGameAsHost, acknowledgeRoleReveal, advanceToPlayingIfAllAcked };

/**
 * ホストのみ：ゲーム開始（役職をランダム割当→revealフェーズへ）
 */
async function startGameAsHost(roomId) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);

  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    const createdBy = data?.config?.createdBy;
    if (createdBy !== userId) {
      throw new Error("Only host can start the game");
    }

    const phase = data?.gameState?.phase || "waiting";
    if (phase !== "waiting") {
      throw new Error(`Game already started (phase: ${phase})`);
    }

    const playersObj = data?.players || {};
    const playerIds = Object.keys(playersObj);
    const count = playerIds.length;
    if (count < 3 || count > 8) {
      throw new Error("Player count must be 3-8 to start");
    }

    // 役職：1狼 + 1ドクター + 残り市民
    const roles = ["wolf", "doctor"];
    while (roles.length < count) roles.push("citizen");

    // シャッフル
    for (let i = roles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }

    /** @type {Record<string, any>} */
    const updates = {
      "gameState.phase": "revealing",
      "gameState.revealAcks": {}, // uid -> true
      "gameState.turn": 1,
      "gameState.whiteStars": 0,
      "gameState.blackStars": 0,
      "gameState.currentPlayerIndex": 0,
      "gameState.currentStage": null,
    };

    playerIds.forEach((pid, idx) => {
      updates[`players.${pid}.role`] = roles[idx];
      updates[`players.${pid}.status`] = "ready";
    });

    tx.update(roomRef, updates);
  });
}

/**
 * 役職確認のOK（revealAck）を送信
 */
async function acknowledgeRoleReveal(roomId) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  await updateDoc(doc(firestore, "rooms", roomId), {
    [`gameState.revealAcks.${userId}`]: true,
  });
}

/**
 * ホストのみ：全員OKならplayingへ
 */
async function advanceToPlayingIfAllAcked(roomId) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);

  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    const createdBy = data?.config?.createdBy;
    if (createdBy !== userId) {
      return; // ホスト以外は何もしない
    }

    const phase = data?.gameState?.phase;
    if (phase !== "revealing") return;

    const playersObj = data?.players || {};
    const playerIds = Object.keys(playersObj);
    const acks = data?.gameState?.revealAcks || {};

    const allAcked = playerIds.length > 0 && playerIds.every((pid) => acks[pid] === true);
    if (!allAcked) return;

    tx.update(roomRef, {
      "gameState.phase": "playing",
      "gameState.revealAcks": {},
    });
  });
}

export { startGameAsHost, acknowledgeRoleReveal, advanceToPlayingIfAllAcked };

// generateRoomIdをグローバルにも公開（main.jsから直接使用可能にする）
if (typeof window !== 'undefined') {
  window.generateRoomId = generateRoomId;
}
