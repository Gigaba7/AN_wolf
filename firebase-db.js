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
      gmName: cleanedRoomConfig.hostName || cleanedRoomConfig.gmName || "GM",
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
      subphase: "gm_stage", // wolf_decision | wolf_resolving | gm_stage | await_result | await_doctor
      wolfDecisionPlayerId: null,
      wolfActionRequest: null, // { playerId, turn }
      lock: null, // 排他制御用
    },
    players: {},
    logs: [],
    randomResults: {},
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
 * 次の手番開始時のサブフェーズを計算（妨害フェーズが必要なら wolf_decision）
 * @param {any} playersObj
 * @param {string[]} order
 * @param {number} idx
 */
function computeStartSubphase(playersObj, order, idx) {
  const currentPlayerId = order[Math.max(0, Math.min(idx, order.length - 1))] || null;
  if (!currentPlayerId) {
    return { subphase: "gm_stage", wolfDecisionPlayerId: null };
  }
  const current = playersObj?.[currentPlayerId] || null;
  if (!current) {
    console.warn(`computeStartSubphase: player ${currentPlayerId} not found`);
    return { subphase: "gm_stage", wolfDecisionPlayerId: null };
  }
  
  // 各プレイヤーの手番の前に、人狼に対して妨害フェーズを表示
  // 人狼のコストが残っている場合のみ
  const wolfPlayer = Object.values(playersObj).find(p => p?.role === "wolf");
  const wolfRes = wolfPlayer?.resources || {};
  const wolfRemain = Number(wolfRes.wolfActionsRemaining || 0);
  
  if (wolfRemain > 0 && wolfPlayer) {
    // 人狼のIDを設定（人狼が妨害を選択する）
    return { subphase: "wolf_decision", wolfDecisionPlayerId: wolfPlayer.id || Object.keys(playersObj).find(pid => playersObj[pid]?.role === "wolf") };
  }
  return { subphase: "gm_stage", wolfDecisionPlayerId: null };
}

/**
 * ルームに参加
 */
async function joinRoom(roomId, playerName, avatarImage = null, avatarLetter = null) {
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
      [`players.${userId}.avatarLetter`]: avatarLetter || playerName[0] || "?",
      [`players.${userId}.avatarImage`]: avatarImage || null,
      [`players.${userId}.status`]: 'ready',
    });
  } else {
    // 新規参加
    await updateDoc(roomRef, {
      [`players.${userId}`]: {
        name: playerName,
        avatarLetter: avatarLetter || playerName[0] || "?",
        avatarImage: avatarImage || null,
        role: null,
        status: 'ready',
        resources: {
          wolfActionsRemaining: 100, // 総コスト100
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
  // NOTE: arrayUnion の要素に serverTimestamp() を含めると Firestore が拒否するため、
  // timestamp は数値（ms）で保存する。将来は rooms/{roomId}/logs サブコレクション化が推奨。
  const logData = {
    ...logEntry,
    timestamp: Date.now(),
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
export {
  createRoom,
  joinRoom,
  generateRoomId,
  subscribeToRoom,
  updateGameState,
  updatePlayerState,
  addLog,
  saveRandomResult,
  acquireLock,
  releaseLock,
  startGameAsHost,
  acknowledgeRoleReveal,
  advanceToPlayingIfAllAcked,
  applySuccess,
  applyFail,
  applyDoctorPunch,
  applyDoctorSkip,
  applyWolfAction,
  activateWolfAction,
  wolfDecision,
  resolveWolfAction,
  resolveWolfActionRoulette,
  computeStartSubphase,
};

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

    const startPhase = computeStartSubphase(playersObj, playerIds, 0);

    /** @type {Record<string, any>} */
    const updates = {
      "gameState.phase": "revealing",
      "gameState.revealAcks": {}, // uid -> true
      "gameState.turn": 1,
      "gameState.whiteStars": 0,
      "gameState.blackStars": 0,
      "gameState.currentPlayerIndex": 0,
      "gameState.currentStage": null,
      "gameState.playerOrder": null,
      "gameState.pendingFailure": null,
      "gameState.stageTurn": null,
      "gameState.subphase": startPhase.subphase,
      "gameState.wolfDecisionPlayerId": startPhase.wolfDecisionPlayerId,
      "gameState.wolfActionRequest": null,
    };

    playerIds.forEach((pid, idx) => {
      updates[`players.${pid}.role`] = roles[idx];
      updates[`players.${pid}.status`] = "ready";
      // resourcesを初期化（役職に応じて）
      const role = roles[idx];
      if (role === "wolf") {
        updates[`players.${pid}.resources.wolfActionsRemaining`] = 100; // 総コスト100
      }
      if (role === "doctor") {
        updates[`players.${pid}.resources.doctorPunchRemaining`] = 5;
        updates[`players.${pid}.resources.doctorPunchAvailableThisTurn`] = true;
      }
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

    // GMも含めて全員がOKを押したかチェック
    const allAcked = playerIds.length > 0 && playerIds.every((pid) => acks[pid] === true);
    if (!allAcked) return;

    // プレイ順をランダム決定（ホストのみ）
    const order = [...playerIds];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    // 各プレイヤーのresourcesを確認・初期化（役職に応じて）
    // トランザクション内で一度に更新するため、updatesオブジェクトにまとめる
    /** @type {Record<string, any>} */
    const resourceUpdates = {};
    const updatedPlayersObj = { ...playersObj };
    
    playerIds.forEach((pid) => {
      const player = playersObj[pid] || {};
      const role = player.role || null;
      const res = player.resources || {};
      
      // 人狼のコストが設定されていない場合は初期化
      if (role === "wolf" && (res.wolfActionsRemaining === undefined || res.wolfActionsRemaining === null)) {
        resourceUpdates[`players.${pid}.resources.wolfActionsRemaining`] = 100; // 総コスト100
        if (!updatedPlayersObj[pid]) updatedPlayersObj[pid] = {};
        if (!updatedPlayersObj[pid].resources) updatedPlayersObj[pid].resources = {};
        updatedPlayersObj[pid].resources.wolfActionsRemaining = 100;
      }
      // ドクターのリソースが設定されていない場合は初期化
      if (role === "doctor") {
        if (res.doctorPunchRemaining === undefined || res.doctorPunchRemaining === null) {
          resourceUpdates[`players.${pid}.resources.doctorPunchRemaining`] = 5;
          if (!updatedPlayersObj[pid]) updatedPlayersObj[pid] = {};
          if (!updatedPlayersObj[pid].resources) updatedPlayersObj[pid].resources = {};
          updatedPlayersObj[pid].resources.doctorPunchRemaining = 5;
        }
        if (res.doctorPunchAvailableThisTurn === undefined || res.doctorPunchAvailableThisTurn === null) {
          resourceUpdates[`players.${pid}.resources.doctorPunchAvailableThisTurn`] = true;
          if (!updatedPlayersObj[pid]) updatedPlayersObj[pid] = {};
          if (!updatedPlayersObj[pid].resources) updatedPlayersObj[pid].resources = {};
          updatedPlayersObj[pid].resources.doctorPunchAvailableThisTurn = true;
        }
      }
    });

    // ゲーム開始時は常に gm_stage フェーズ（ステージ選出を優先）
    // 妨害フェーズはステージ選出完了後に設定される
    tx.update(roomRef, {
      ...resourceUpdates,
      "gameState.phase": "playing",
      "gameState.revealAcks": {},
      "gameState.playerOrder": order,
      "gameState.currentPlayerIndex": 0,
      "gameState.pendingFailure": null,
      "gameState.currentStage": null,
      "gameState.stageTurn": null,
      "gameState.subphase": "gm_stage", // ステージ選出を優先
      "gameState.wolfDecisionPlayerId": null,
      "gameState.wolfActionRequest": null,
    });
  });
}

/**
 * ターンを確定して次ターンへ進める（○ or × を追加し、順番を再抽選、ステージをクリア）
 * - ○: 1周（=全員行動）が完了したとき
 * - ×: 失敗して「神拳を使わない」が確定したとき（即次ターン）
 * @param {any} tx
 * @param {any} roomRef
 * @param {any} data
 * @param {any} playersObj
 * @param {string[]} order
 * @param {boolean} isFailureTurn
 * @param {Record<string, any>} extraUpdates
 */
function endTurnAndPrepareNext(tx, roomRef, data, playersObj, order, isFailureTurn, extraUpdates = {}) {
  const maxTurns = Number(data?.gameState?.maxTurns || 5);
  const turn = Number(data?.gameState?.turn || 1);

  let whiteStars = Number(data?.gameState?.whiteStars || 0);
  let blackStars = Number(data?.gameState?.blackStars || 0);

  if (isFailureTurn) blackStars += 1;
  else whiteStars += 1;

  const completedTurns = whiteStars + blackStars;
  const finished = completedTurns >= maxTurns;

  let nextTurn = turn + 1;
  if (finished) nextTurn = maxTurns;

  // プレイ順は保持（ターンごとのシャッフルは不要）
  const nextOrder = [...order];

  const startPhase = computeStartSubphase(playersObj, nextOrder, 0);

  /** @type {Record<string, any>} */
  const updates = {
    ...extraUpdates,
    "gameState.whiteStars": whiteStars,
    "gameState.blackStars": blackStars,
    "gameState.turn": nextTurn,
    "gameState.playerOrder": nextOrder,
    "gameState.currentPlayerIndex": 0,
    "gameState.pendingFailure": null,
    "gameState.currentStage": null,
    "gameState.stageTurn": null,
    "gameState.subphase": startPhase.subphase,
    "gameState.wolfDecisionPlayerId": startPhase.wolfDecisionPlayerId,
    "gameState.wolfActionRequest": null,
  };

  // ターン開始時にドクター神拳を「使用可能」に戻す
  const doctorId = Object.keys(playersObj).find((pid) => playersObj?.[pid]?.role === "doctor") || null;
  if (doctorId) {
    updates[`players.${doctorId}.resources.doctorPunchAvailableThisTurn`] = true;
  }

  if (finished) {
    updates["gameState.phase"] = "finished";
  }

  // ターン終了時に成功/失敗フラグを設定（ポップアップ表示用）
  updates["gameState.turnResult"] = isFailureTurn ? "failure" : "success";

  tx.update(roomRef, updates);
}

/**
 * プレイ中の成功を確定（現在プレイヤーのみ）
 */
async function applySuccess(roomId) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);

  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    if (data?.gameState?.phase !== "playing") throw new Error("Game is not in playing phase");

    const createdBy = data?.config?.createdBy;
    if (createdBy !== userId) throw new Error("Only GM can submit success/fail");

    const playersObj = data?.players || {};
    const order = Array.isArray(data?.gameState?.playerOrder) && data.gameState.playerOrder.length
      ? data.gameState.playerOrder
      : Object.keys(playersObj);
    const idx = Number(data?.gameState?.currentPlayerIndex || 0);

    if (data?.gameState?.subphase !== "await_result") {
      throw new Error("Not ready to judge (stage selection not completed)");
    }

    if (!data?.gameState?.currentStage) {
      throw new Error("Stage not selected");
    }

    if (data?.gameState?.pendingFailure) {
      throw new Error("A failure is pending");
    }

    const nextIndex = (idx + 1) % order.length;
    // 1周したら「○」でターン終了（=全員完了）
    if (nextIndex === 0) {
      endTurnAndPrepareNext(tx, roomRef, data, playersObj, order, false);
      return;
    }

    const startPhase = computeStartSubphase(playersObj, order, nextIndex);
    // そのターン中はステージを保持（次のプレイヤーに進んでも同じステージ）
    tx.update(roomRef, {
      "gameState.currentPlayerIndex": nextIndex,
      // currentStage と stageTurn は保持（そのターン中は固定）
      "gameState.subphase": startPhase.subphase,
      "gameState.wolfDecisionPlayerId": startPhase.wolfDecisionPlayerId,
      "gameState.wolfActionRequest": null,
    });
  });
}

/**
 * プレイ中の失敗入力（現在プレイヤーのみ）
 * - ドクター神拳が使用可能なら「神拳使用フェーズ」（pendingFailure）へ
 * - 神拳を使う → 成功扱いで次のプレイヤーへ
 * - 神拳を使わない → ×確定で即次ターンへ
 */
async function applyFail(roomId) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);

  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    if (data?.gameState?.phase !== "playing") throw new Error("Game is not in playing phase");

    const createdBy = data?.config?.createdBy;
    if (createdBy !== userId) throw new Error("Only GM can submit success/fail");

    const playersObj = data?.players || {};
    const order = Array.isArray(data?.gameState?.playerOrder) && data.gameState.playerOrder.length
      ? data.gameState.playerOrder
      : Object.keys(playersObj);
    const idx = Number(data?.gameState?.currentPlayerIndex || 0);

    if (!data?.gameState?.currentStage) {
      throw new Error("Stage not selected");
    }

    const pending = data?.gameState?.pendingFailure || null;

    // ドクターがいて、神拳が使えるなら保留にする
    const doctorId = Object.keys(playersObj).find((pid) => playersObj?.[pid]?.role === "doctor") || null;
    const doctorRes = doctorId ? (playersObj?.[doctorId]?.resources || {}) : null;
    const docRemain = doctorRes ? Number(doctorRes.doctorPunchRemaining || 0) : 0;
    const docAvail = doctorRes ? doctorRes.doctorPunchAvailableThisTurn !== false : false;

    // すでに保留なら「神拳を使わない（失敗確定）」＝×で即次ターン
    // これはGMが「失敗確定（神拳なし）」ボタンを押した場合
    if (pending) {
      endTurnAndPrepareNext(tx, roomRef, data, playersObj, order, true, {
        "gameState.pendingFailure": null,
      });
      return;
    }

    // 神拳が使えるなら保留にする（進行は止まる）
    if (doctorId && docRemain > 0 && docAvail) {
      tx.update(roomRef, {
        "gameState.pendingFailure": { playerId: order[idx] },
        "gameState.subphase": "await_doctor",
      });
      return;
    }

    // 神拳が無いので失敗確定：×で即次ターン
    endTurnAndPrepareNext(tx, roomRef, data, playersObj, order, true, {
      "gameState.pendingFailure": null,
    });
  });
}

/**
 * ドクター神拳（ドクターのみ）
 */
async function applyDoctorPunch(roomId) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);

  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    if (data?.gameState?.phase !== "playing") throw new Error("Game is not in playing phase");

    const playersObj = data?.players || {};
    const me = playersObj?.[userId];
    if (!me || me.role !== "doctor") throw new Error("Only doctor can use Doctor Punch");

    const pending = data?.gameState?.pendingFailure;
    if (!pending) throw new Error("No pending failure");

    const res = me.resources || {};
    const remain = Number(res.doctorPunchRemaining || 0);
    const avail = res.doctorPunchAvailableThisTurn !== false;
    if (remain <= 0 || !avail) throw new Error("Doctor Punch not available");

    const order = Array.isArray(data?.gameState?.playerOrder) && data.gameState.playerOrder.length
      ? data.gameState.playerOrder
      : Object.keys(playersObj);
    const idx = Number(data?.gameState?.currentPlayerIndex || 0);

    // 失敗保留は「現在プレイヤーの失敗」である必要がある（進行が止まっている前提）
    const currentPlayerId = order[idx];
    if (pending?.playerId && pending.playerId !== currentPlayerId) {
      throw new Error("Pending failure is not for current player");
    }

    const nextIndex = (idx + 1) % order.length;

    // 神拳使用＝成功扱いで次へ進む（ターン内は1回まで）
    if (nextIndex === 0) {
      // 1周完了なので「○」でターン終了（次ターンでは使用可に戻す）
      endTurnAndPrepareNext(tx, roomRef, data, playersObj, order, false, {
        "gameState.pendingFailure": null,
        [`players.${userId}.resources.doctorPunchRemaining`]: remain - 1,
        // 次ターン開始時に true に戻すので、ここでは設定しない
      });
      return;
    }

    // ドクター神拳発動後は次のプレイヤーの手番開始時に妨害フェーズを設定
    // 妨害フェーズは各プレイヤーの手番開始時（挑戦の直前）に発動する
    const startPhase = computeStartSubphase(playersObj, order, nextIndex);
    tx.update(roomRef, {
      "gameState.currentPlayerIndex": nextIndex,
      "gameState.pendingFailure": null,
      // currentStage と stageTurn は保持（そのターン中は固定）
      [`players.${userId}.resources.doctorPunchRemaining`]: remain - 1,
      [`players.${userId}.resources.doctorPunchAvailableThisTurn`]: false,
      "gameState.subphase": startPhase.subphase,
      "gameState.wolfDecisionPlayerId": startPhase.wolfDecisionPlayerId,
      "gameState.wolfActionRequest": null,
    });
  });
}

/**
 * 人狼：手番開始時の妨害使用可否を決定（wolf_decision フェーズ）
 * @param {string} roomId
 * @param {"use"|"skip"} decision
 */
async function wolfDecision(roomId, decision) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);
  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();
    if (data?.gameState?.phase !== "playing") throw new Error("Game is not in playing phase");

    const playersObj = data?.players || {};
    const me = playersObj?.[userId];
    if (!me || me.role !== "wolf") throw new Error("Only werewolf can decide obstruction");

    if (data?.gameState?.subphase !== "wolf_decision") throw new Error("Not in wolf decision phase");
    if (data?.gameState?.wolfDecisionPlayerId && data.gameState.wolfDecisionPlayerId !== userId) {
      throw new Error("Not your wolf decision");
    }

    if (decision === "skip") {
      // スキップ：妨害を使用しない（直接await_resultへ、ステージ選出済みの場合）
      // ステージが選出済みの場合は await_result、未選出の場合は gm_stage
      const currentStage = data?.gameState?.currentStage || null;
      const nextSubphase = currentStage ? "await_result" : "gm_stage";
      
      tx.update(roomRef, {
        "gameState.subphase": nextSubphase,
        "gameState.wolfDecisionPlayerId": null,
        "gameState.wolfActionRequest": null,
      });
      return;
    }

    // use: 旧実装（後方互換性のため保持）
    // 新実装では activateWolfAction を直接呼ぶため、この分岐は使用されない
    const currentStage = data?.gameState?.currentStage || null;
    const nextSubphase = currentStage ? "await_result" : "gm_stage";
    
    tx.update(roomRef, {
      "gameState.subphase": nextSubphase,
      "gameState.wolfDecisionPlayerId": null,
      "gameState.wolfActionRequest": null,
    });
  });
}

/**
 * GM：人狼妨害の選出結果を確定し、ログに記載する（旧実装、後方互換性のため保持）
 * @param {string} roomId
 * @param {string} actionText
 */
async function resolveWolfAction(roomId, actionText) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);
  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    const createdBy = data?.config?.createdBy;
    if (createdBy !== userId) throw new Error("Only GM can resolve obstruction");

    if (data?.gameState?.phase !== "playing") throw new Error("Game is not in playing phase");
    if (data?.gameState?.subphase !== "wolf_resolving") throw new Error("Not in obstruction resolving phase");

    const req = data?.gameState?.wolfActionRequest || null;
    const wolfId = req?.playerId || null;
    if (!wolfId) throw new Error("No obstruction request");

    const playersObj = data?.players || {};
    const wolf = playersObj?.[wolfId];
    if (!wolf || wolf.role !== "wolf") throw new Error("Requester is not wolf");

    const res = wolf.resources || {};
    const remain = Number(res.wolfActionsRemaining || 0);
    if (remain <= 0) throw new Error("No remaining wolf actions");

    const order = Array.isArray(data?.gameState?.playerOrder) && data.gameState.playerOrder.length
      ? data.gameState.playerOrder
      : Object.keys(playersObj);
    const idx = Number(data?.gameState?.currentPlayerIndex || 0);
    const currentPlayerId = order[idx];
    if (currentPlayerId !== wolfId) throw new Error("Obstruction requester is not current player");

    const logData = {
      type: "wolfAction",
      message: `人狼妨害：${actionText}`,
      timestamp: Date.now(),
      userId,
      playerId: wolfId,
    };

    tx.update(roomRef, {
      [`players.${wolfId}.resources.wolfActionsRemaining`]: remain - 1,
      "gameState.subphase": "gm_stage",
      "gameState.wolfActionRequest": null,
      logs: arrayUnion(logData),
    });
  });
}

/**
 * GM：職業ルーレットの結果を確定し、ログに記載する（ランダム職業使用禁止用）
 * @param {string} roomId
 * @param {string} selectedJob
 */
async function resolveWolfActionRoulette(roomId, selectedJob) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);
  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    const createdBy = data?.config?.createdBy;
    if (createdBy !== userId) throw new Error("Only GM can resolve roulette");

    if (data?.gameState?.phase !== "playing") throw new Error("Game is not in playing phase");
    if (data?.gameState?.subphase !== "wolf_resolving") throw new Error("Not in roulette resolving phase");

    const req = data?.gameState?.wolfActionRequest || null;
    const wolfId = req?.playerId || null;
    const actionText = req?.actionText || "ランダム職業使用禁止";
    if (!wolfId) throw new Error("No obstruction request");

    const playersObj = data?.players || {};
    const wolf = playersObj?.[wolfId];
    if (!wolf || wolf.role !== "wolf") throw new Error("Requester is not wolf");

    const logData = {
      type: "wolfAction",
      message: `妨害『${actionText}』が発動されました（使用禁止職業: ${selectedJob}）`,
      timestamp: Date.now(),
      userId,
      playerId: wolfId,
    };

    // ルーレット確定後、subphaseをawait_resultに戻す（妨害フェーズ終了、ステージ選出済みなので結果待ち）
    const currentStage = data?.gameState?.currentStage || null;
    const nextSubphase = currentStage ? "await_result" : "gm_stage";
    
    tx.update(roomRef, {
      "gameState.wolfActionNotification": { text: `${actionText}（使用禁止職業: ${selectedJob}）`, timestamp: Date.now() },
      "gameState.subphase": nextSubphase,
      "gameState.wolfActionRequest": null,
      logs: arrayUnion(logData),
    });
  });
}

/**
 * 人狼妨害（人狼のみ） - 旧実装（後方互換性のため保持）
 */
async function applyWolfAction(roomId) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);

  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    if (data?.gameState?.phase !== "playing") throw new Error("Game is not in playing phase");

    const playersObj = data?.players || {};
    const me = playersObj?.[userId];
    if (!me || me.role !== "wolf") throw new Error("Only werewolf can use obstruction");

    const res = me.resources || {};
    const remain = Number(res.wolfActionsRemaining || 0);
    if (remain <= 0) throw new Error("No remaining wolf actions");

    tx.update(roomRef, {
      [`players.${userId}.resources.wolfActionsRemaining`]: remain - 1,
    });
  });
}

/**
 * 人狼妨害の即時発動（新実装：任意選択→即時発動）
 * @param {string} roomId
 * @param {string} actionText
 * @param {number} actionCost
 * @param {boolean} requiresRoulette - ルーレットが必要な場合true
 * @param {string[]} rouletteOptions - ルーレットの選択肢（requiresRouletteがtrueの場合）
 */
async function activateWolfAction(roomId, actionText, actionCost, requiresRoulette = false, rouletteOptions = null) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);

  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    if (data?.gameState?.phase !== "playing") throw new Error("Game is not in playing phase");

    const playersObj = data?.players || {};
    const me = playersObj?.[userId];
    if (!me || me.role !== "wolf") throw new Error("Only werewolf can activate obstruction");

    const res = me.resources || {};
    const currentCost = Number(res.wolfActionsRemaining || 0);
    if (currentCost < actionCost) {
      throw new Error(`Insufficient cost: need ${actionCost}, have ${currentCost}`);
    }

    // 同一ターン中に複数妨害は使用不可（1ターン1回制限）
    const turn = Number(data?.gameState?.turn || 1);
    const lastUsedTurn = Number(res.wolfActionLastUsedTurn || 0);
    if (lastUsedTurn === turn) {
      throw new Error("Only one obstruction per turn is allowed");
    }

    // ルーレットが必要な場合は、GM画面でルーレットを実行する必要がある
    if (requiresRoulette && Array.isArray(rouletteOptions) && rouletteOptions.length > 0) {
      // ルーレットリクエストを設定（GM画面でルーレットを実行）
      tx.update(roomRef, {
        [`players.${userId}.resources.wolfActionsRemaining`]: currentCost - actionCost,
        [`players.${userId}.resources.wolfActionLastUsedTurn`]: turn,
        "gameState.wolfActionRequest": {
          playerId: userId,
          actionText: actionText,
          rouletteOptions: rouletteOptions,
          timestamp: Date.now(),
        },
        "gameState.subphase": "wolf_resolving",
        "gameState.wolfDecisionPlayerId": null,
      });
      return;
    }

    const logData = {
      type: "wolfAction",
      message: `妨害『${actionText}』が発動されました`,
      timestamp: Date.now(),
      userId,
      playerId: userId,
    };

    // 妨害発動後、subphaseをawait_resultに戻す（妨害フェーズ終了、ステージ選出済みなので結果待ち）
    const currentStage = data?.gameState?.currentStage || null;
    const nextSubphase = currentStage ? "await_result" : "gm_stage";
    
    tx.update(roomRef, {
      [`players.${userId}.resources.wolfActionsRemaining`]: currentCost - actionCost,
      [`players.${userId}.resources.wolfActionLastUsedTurn`]: turn,
      "gameState.wolfActionNotification": { text: actionText, timestamp: Date.now() },
      "gameState.subphase": nextSubphase,
      "gameState.wolfDecisionPlayerId": null,
      "gameState.wolfActionRequest": null,
      logs: arrayUnion(logData),
    });
  });
}

// generateRoomIdをグローバルにも公開（main.jsから直接使用可能にする）
if (typeof window !== 'undefined') {
  window.generateRoomId = generateRoomId;
}
