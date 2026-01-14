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
      phase: 'waiting', // waiting | playing | final_phase | finished
      currentStage: null,
      whiteStars: 0,
      blackStars: 0,
      currentPlayerIndex: 0,
      subphase: "gm_stage", // challenge_start | wolf_decision | wolf_resolving | gm_stage | await_result | await_doctor
      wolfDecisionPlayerId: null,
      wolfActionRequest: null, // { playerId, turn }
      doctorHasFailed: false, // ドクターが一度でも失敗したか（神拳で打ち消しても失敗として記録）
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
  
  // 各プレイヤーの手番は challenge_start から開始（「○○の挑戦です」を表示）
  return { subphase: "challenge_start", wolfDecisionPlayerId: null };
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
    // ルーム設定から初期コストを取得、なければデフォルト100
    const wolfInitialCost = roomData?.config?.wolfInitialCost || 100;
    await updateDoc(roomRef, {
      [`players.${userId}`]: {
        name: playerName,
        avatarLetter: avatarLetter || playerName[0] || "?",
        avatarImage: avatarImage || null,
        role: null,
        status: 'ready',
        resources: {
          wolfActionsRemaining: wolfInitialCost,
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
  proceedToNextPlayerAfterDoctorPunch,
  applyWolfAction,
  activateWolfAction,
  wolfDecision,
  resolveWolfAction,
  resolveWolfActionRoulette,
  clearWolfActionNotification,
  clearDoctorSkipNotification,
  clearTurnResult,
  proceedToNextPlayerChallenge,
  computeStartSubphase,
  identifyWolf,
  startDiscussionPhase,
  endDiscussionPhase,
  extendDiscussionPhase,
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

    // ロビーに戻る確認メカニズム：全員がロビーに戻るまでゲーム開始をブロック
    const resultReturnLobbyAcks = data?.gameState?.resultReturnLobbyAcks || {};
    const allReturnedLobby = playerIds.every((pid) => resultReturnLobbyAcks[pid] === true);
    if (!allReturnedLobby && Object.keys(resultReturnLobbyAcks).length > 0) {
      // resultReturnLobbyAcksが存在する場合（結果表示からロビーに戻った場合）、全員がロビーに戻るまで待つ
      throw new Error("全員がロビーに戻るまでゲームを開始できません");
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
        // ルーム設定から初期コストを取得、なければデフォルト100
        const wolfInitialCost = data?.config?.wolfInitialCost || 100;
        updates[`players.${pid}.resources.wolfActionsRemaining`] = wolfInitialCost;
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
        // ルーム設定から初期コストを取得、なければデフォルト100
        const wolfInitialCost = data?.config?.wolfInitialCost || 100;
        resourceUpdates[`players.${pid}.resources.wolfActionsRemaining`] = wolfInitialCost;
        if (!updatedPlayersObj[pid]) updatedPlayersObj[pid] = {};
        if (!updatedPlayersObj[pid].resources) updatedPlayersObj[pid].resources = {};
        updatedPlayersObj[pid].resources.wolfActionsRemaining = wolfInitialCost;
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

  // ターン開始時は常にステージ選出から始まる（妨害フェーズはステージ選出後に設定される）
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
    "gameState.subphase": "gm_stage", // 常にステージ選出から開始
    "gameState.wolfDecisionPlayerId": null,
    "gameState.wolfActionRequest": null,
    "gameState.pendingDoctorPunchProceed": null, // ドクター神拳進行フラグをクリア
    "gameState.wolfActionNotification": null, // 妨害通知をクリア
  };

  // ターン開始時にドクター神拳を「使用可能」に戻す
  const doctorId = Object.keys(playersObj).find((pid) => playersObj?.[pid]?.role === "doctor") || null;
  if (doctorId) {
    updates[`players.${doctorId}.resources.doctorPunchAvailableThisTurn`] = true;
  }

  // 勝敗判定
  const majority = Math.ceil(maxTurns / 2); // 過半数（3ターンの場合は2、5ターンの場合は3）
  const doctorHasFailed = data?.gameState?.doctorHasFailed === true || extraUpdates?.["gameState.doctorHasFailed"] === true;

  // ターン終了時に成功/失敗フラグを設定（ポップアップ表示用）
  // 現在のターン番号を保存（次のターンに進む前に表示するため）
  updates["gameState.turnResult"] = isFailureTurn ? "failure" : "success";
  updates["gameState.turnResultTurn"] = turn; // ターン結果を表示する際のターン番号

  // ドクターが失敗し、神拳も使用できなかった場合は即座に人狼勝利（会議フェーズなし）
  // ただし、現在のターンで失敗した場合のみ（isFailureTurnがtrueで、doctorHasFailedがextraUpdatesで設定された場合）
  const doctorFailedThisTurn = isFailureTurn && extraUpdates?.["gameState.doctorHasFailed"] === true;
  if (doctorFailedThisTurn) {
    updates["gameState.phase"] = "finished";
    updates["gameState.gameResult"] = "wolf_win";
  }
  // ○が過半数以上 → 市民勝利（会議フェーズなし）
  else if (whiteStars >= majority) {
    updates["gameState.phase"] = "finished";
    updates["gameState.gameResult"] = "citizen_win";
  }
  // ×が過半数以上 → 会議フェーズ後に最終フェーズへ
  else if (blackStars >= majority) {
    // 会議フェーズを開始（5分）
    const endTime = Date.now() + 5 * 60 * 1000;
    updates["gameState.discussionPhase"] = true;
    updates["gameState.discussionEndTime"] = endTime;
    updates["gameState.pendingFinalPhase"] = true; // 最終フェーズ前の会議フラグ
    // 最終フェーズへの移行は会議フェーズ終了時に実行
  }
  // ターン数が最大に達した場合
  else if (finished) {
    // 同数の場合は×が多い方が勝利（通常は到達しないが念のため）
    if (blackStars > whiteStars) {
      // 会議フェーズを開始（5分）
      const endTime = Date.now() + 5 * 60 * 1000;
      updates["gameState.discussionPhase"] = true;
      updates["gameState.discussionEndTime"] = endTime;
      updates["gameState.pendingFinalPhase"] = true; // 最終フェーズ前の会議フラグ
      // 最終フェーズへの移行は会議フェーズ終了時に実行
    } else {
      updates["gameState.phase"] = "finished";
      updates["gameState.gameResult"] = "citizen_win";
    }
  }
  // 次のターンに進む場合 → 会議フェーズを開始（5分）
  // ただし、ターン結果ポップアップが表示されるまで待つため、discussionPhaseは後で設定
  // （syncGameStateFromFirebaseでturnResultが表示された後にhandleDiscussionPhaseが呼ばれる）
  else {
    // 会議フェーズを開始（5分）
    // ただし、タイマー表示はターン結果ポップアップが閉じた後に行う
    const endTime = Date.now() + 5 * 60 * 1000;
    updates["gameState.discussionEndTime"] = endTime;
    // discussionPhaseは後で設定（turnResult表示後に）
    // ここでは設定しない
  }

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

    // 次のプレイヤーは challenge_start から開始（「○○の挑戦です」を表示）
    // ただし、挑戦結果ポップアップが表示されるまで待つため、challenge_startへの移行は後で行う
    // ここでは次のプレイヤーのインデックスのみ更新し、subphaseはawait_resultのまま
    const updates = {
      "gameState.currentPlayerIndex": nextIndex,
      // currentStage と stageTurn は保持（そのターン中は固定）
      // subphaseはawait_resultのまま（挑戦結果ポップアップが表示された後にchallenge_startに移行）
      "gameState.pendingNextPlayerChallenge": true, // 次のプレイヤーの挑戦開始フラグ
      "gameState.wolfDecisionPlayerId": null,
      "gameState.wolfActionRequest": null,
    };
    
    // 背水の陣などの妨害効果を解除（次の挑戦が完了したので）
    const doctorId = Object.keys(playersObj).find((pid) => playersObj?.[pid]?.role === "doctor") || null;
    if (doctorId) {
      const doctorRes = playersObj[doctorId]?.resources || {};
      if (doctorRes.doctorPunchAvailableThisTurn === false) {
        // 妨害効果が適用されている場合、次の挑戦が完了したので解除
        updates[`players.${doctorId}.resources.doctorPunchAvailableThisTurn`] = true;
      }
    }
    
    tx.update(roomRef, updates);
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

    // 現在のプレイヤーがドクターかどうかを確認
    const currentPlayerId = order[idx];
    const isDoctor = doctorId && currentPlayerId === doctorId;
    
    // すでに保留なら「神拳を使わない（失敗確定）」＝×で即次ターン
    // これはGMが「失敗確定（神拳なし）」ボタンを押した場合
    if (pending) {
      const pendingPlayerId = pending.playerId || order[pending.playerIndex] || currentPlayerId;
      const isPendingDoctor = doctorId && pendingPlayerId === doctorId;
      
      // ドクターが失敗した場合、失敗履歴を記録
      const updates = { "gameState.pendingFailure": null };
      if (isPendingDoctor) {
        updates["gameState.doctorHasFailed"] = true;
      }
      
      endTurnAndPrepareNext(tx, roomRef, data, playersObj, order, true, updates);
      return;
    }

    // 神拳が使えるなら保留にする（進行は止まる）
    if (doctorId && docRemain > 0 && docAvail) {
      // ドクターが失敗した場合、失敗履歴を記録（神拳で打ち消しても失敗として記録）
      const updates = {
        "gameState.pendingFailure": { playerId: order[idx] },
        "gameState.subphase": "await_doctor",
      };
      if (isDoctor) {
        updates["gameState.doctorHasFailed"] = true;
      }
      
      tx.update(roomRef, updates);
      return;
    }

    // 神拳が無いので失敗確定：×で即次ターン
    // ドクターが失敗した場合、失敗履歴を記録
    const updates = { "gameState.pendingFailure": null };
    if (isDoctor) {
      updates["gameState.doctorHasFailed"] = true;
    }
    
    // 妨害効果の解除：次のプレイヤーの挑戦が完了したので、背水の陣などの効果を解除
    // doctorIdは既に定義されているので、doctorResを直接使用
    if (doctorId && doctorRes) {
      if (doctorRes.doctorPunchAvailableThisTurn === false) {
        // 妨害効果が適用されている場合、次の挑戦が完了したので解除
        updates[`players.${doctorId}.resources.doctorPunchAvailableThisTurn`] = true;
      }
    }
    
    endTurnAndPrepareNext(tx, roomRef, data, playersObj, order, true, updates);
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

    // ドクターが失敗した場合、失敗履歴を記録（神拳で打ち消した場合は失敗として記録しない）
    const pendingPlayerId = pending?.playerId || currentPlayerId;
    const isPendingDoctor = pendingPlayerId === userId;

    const nextIndex = (idx + 1) % order.length;

    // 神拳使用＝成功扱いで次へ進む（ターン内は1回まで）
    // ただし、神拳で打ち消した場合でもdoctorHasFailedをtrueにして、最終フェーズの逆転投票を防ぐ
    if (nextIndex === 0) {
      // 1周完了なので「○」でターン終了（次ターンでは使用可に戻す）
      const updates = {
        "gameState.pendingFailure": null,
        [`players.${userId}.resources.doctorPunchRemaining`]: remain - 1,
        // 次ターン開始時に true に戻すので、ここでは設定しない
      };
      // 神拳で打ち消した場合でも、最終フェーズの逆転投票を防ぐためにdoctorHasFailedをtrueにする
      if (isPendingDoctor) {
        updates["gameState.doctorHasFailed"] = true;
      }
      endTurnAndPrepareNext(tx, roomRef, data, playersObj, order, false, updates);
      return;
    }

    // ドクター神拳発動後は、OKボタンを押すまで次のプレイヤーに進まない
    // subphaseはawait_resultのままにして、OKボタンで妨害フェーズに移行する
    const updates = {
      "gameState.currentPlayerIndex": nextIndex,
      "gameState.pendingFailure": null,
      // currentStage と stageTurn は保持（そのターン中は固定）
      "gameState.subphase": "await_result", // OKボタンを押すまでawait_resultのまま
      [`players.${userId}.resources.doctorPunchRemaining`]: remain - 1,
      [`players.${userId}.resources.doctorPunchAvailableThisTurn`]: false,
      "gameState.pendingDoctorPunchProceed": true, // OKボタンで進むフラグ
    };
    // 神拳で打ち消した場合でも、最終フェーズの逆転投票を防ぐためにdoctorHasFailedをtrueにする
    if (isPendingDoctor) {
      updates["gameState.doctorHasFailed"] = true;
    }
    
    tx.update(roomRef, updates);
  });
}

/**
 * ドクター神拳発動後、OKボタンを押した時に次のプレイヤーの妨害フェーズに進む
 */
async function proceedToNextPlayerAfterDoctorPunch(roomId) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);

  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    if (data?.gameState?.phase !== "playing") throw new Error("Game is not in playing phase");

    // pendingDoctorPunchProceedフラグが立っている場合のみ実行
    if (!data?.gameState?.pendingDoctorPunchProceed) {
      throw new Error("Not waiting for doctor punch proceed");
    }

    const playersObj = data?.players || {};
    const order = Array.isArray(data?.gameState?.playerOrder) && data.gameState.playerOrder.length
      ? data.gameState.playerOrder
      : Object.keys(playersObj);
    const idx = Number(data?.gameState?.currentPlayerIndex || 0);

    // 次のプレイヤーは challenge_start から開始（「○○の挑戦です」を表示）
    // ただし、挑戦結果ポップアップが表示されるまで待つため、challenge_startへの移行は後で行う
    // ここでは次のプレイヤーのインデックスのみ更新し、subphaseはawait_resultのまま
    const nextIndex = (idx + 1) % order.length;
    // 1周したら「○」でターン終了（=全員完了）
    if (nextIndex === 0) {
      endTurnAndPrepareNext(tx, roomRef, data, playersObj, order, false);
      return;
    }
    
    tx.update(roomRef, {
      "gameState.currentPlayerIndex": nextIndex,
      "gameState.subphase": "await_result", // 挑戦結果ポップアップが表示されるまで待つ
      "gameState.pendingNextPlayerChallenge": true, // 次のプレイヤーの挑戦開始フラグ
      "gameState.wolfDecisionPlayerId": null,
      "gameState.wolfActionRequest": null,
      "gameState.pendingDoctorPunchProceed": null, // フラグをクリア
      "gameState.pendingFailure": null, // 念のためpendingFailureもクリア
    });
  });
}

/**
 * ドクター神拳をスキップ（使用しない）
 */
async function applyDoctorSkip(roomId) {
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
    if (!me || me.role !== "doctor") throw new Error("Only doctor can skip Doctor Punch");

    const pending = data?.gameState?.pendingFailure;
    if (!pending) throw new Error("No pending failure");

    const order = Array.isArray(data?.gameState?.playerOrder) && data.gameState.playerOrder.length
      ? data.gameState.playerOrder
      : Object.keys(playersObj);
    const idx = Number(data?.gameState?.currentPlayerIndex || 0);

    // 失敗保留は「現在プレイヤーの失敗」である必要がある
    const currentPlayerId = order[idx];
    if (pending?.playerId && pending.playerId !== currentPlayerId) {
      throw new Error("Pending failure is not for current player");
    }

    // 神拳を使わない＝失敗確定で即次ターンへ
    // ドクターが失敗した場合、失敗履歴を記録
    const doctorId = Object.keys(playersObj).find((pid) => playersObj?.[pid]?.role === "doctor") || null;
    const pendingPlayerId = pending?.playerId || order[idx];
    const isPendingDoctor = doctorId && pendingPlayerId === doctorId;
    
    const updates = {
      "gameState.pendingFailure": null,
      // GM側で「失敗確定」ポップアップを出すための通知（表示後にクリアされる）
      "gameState.doctorSkipNotification": {
        playerId: pendingPlayerId,
        timestamp: Date.now(),
      },
    };
    if (isPendingDoctor) {
      updates["gameState.doctorHasFailed"] = true;
    }
    
    endTurnAndPrepareNext(tx, roomRef, data, playersObj, order, true, updates);
  });
}

/**
 * ドクター神拳不使用通知をクリア（GMのみ）
 */
async function clearDoctorSkipNotification(roomId) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);
  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    const createdBy = data?.config?.createdBy;
    if (createdBy !== userId) throw new Error("Only GM can clear doctor skip notification");

    tx.update(roomRef, {
      "gameState.doctorSkipNotification": null,
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
 * @param {string} announcementTitle - アナウンスタイトル
 * @param {string} announcementSubtitle - アナウンスサブタイトル（選択された職業を含む）
 * @param {string} logMessage - ログメッセージ
 */
async function resolveWolfActionRoulette(roomId, selectedJob, announcementTitle = null, announcementSubtitle = null, logMessage = null) {
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
      message: logMessage || `妨害『${actionText}』が発動されました（使用禁止職業: ${selectedJob}）`,
      timestamp: Date.now(),
      userId,
      playerId: wolfId,
    };

    // ルーレット確定後、subphaseをawait_resultに戻す（妨害フェーズ終了、ステージ選出済みなので結果待ち）
    const currentStage = data?.gameState?.currentStage || null;
    const nextSubphase = currentStage ? "await_result" : "gm_stage";
    
    const updates = {
      "gameState.wolfActionNotification": { 
        text: `${actionText}（使用禁止職業: ${selectedJob}）`, 
        announcementTitle: announcementTitle || `妨害『${actionText}』が発動されました`,
        announcementSubtitle: announcementSubtitle || null,
        logMessage: logMessage || `妨害『${actionText}』が発動されました（使用禁止職業: ${selectedJob}）`,
        timestamp: Date.now() 
      },
      "gameState.subphase": nextSubphase,
      "gameState.wolfActionRequest": null,
      logs: arrayUnion(logData),
    };
    
    // 背水の陣が発動された場合、ドクター神拳使用不可フラグを設定
    if (actionText === "背水の陣") {
      const doctorId = Object.keys(playersObj).find((pid) => playersObj?.[pid]?.role === "doctor") || null;
      if (doctorId) {
        updates[`players.${doctorId}.resources.doctorPunchAvailableThisTurn`] = false;
      }
    }
    
    tx.update(roomRef, updates);
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
 * @param {string} announcementTitle - アナウンスタイトル
 * @param {string} announcementSubtitle - アナウンスサブタイトル
 * @param {string} logMessage - ログメッセージ
 */
async function activateWolfAction(roomId, actionText, actionCost, requiresRoulette = false, rouletteOptions = null, announcementTitle = null, announcementSubtitle = null, logMessage = null) {
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

    // ルーレットが必要な場合は、GM画面でルーレットを実行する必要がある
    if (requiresRoulette && Array.isArray(rouletteOptions) && rouletteOptions.length > 0) {
      // ルーレットリクエストを設定（GM画面でルーレットを実行）
      tx.update(roomRef, {
        [`players.${userId}.resources.wolfActionsRemaining`]: currentCost - actionCost,
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
      message: logMessage || `妨害『${actionText}』が発動されました`,
      timestamp: Date.now(),
      userId,
      playerId: userId,
    };

    // 妨害発動後、subphaseをawait_resultに戻す（妨害フェーズ終了、ステージ選出済みなので結果待ち）
    const currentStage = data?.gameState?.currentStage || null;
    const nextSubphase = currentStage ? "await_result" : "gm_stage";
    
    // 背水の陣が発動された場合、ドクター神拳使用不可フラグを設定
    const updates = {
      [`players.${userId}.resources.wolfActionsRemaining`]: currentCost - actionCost,
      "gameState.wolfActionNotification": { 
        text: actionText, 
        announcementTitle: announcementTitle || `妨害『${actionText}』が発動されました`,
        announcementSubtitle: announcementSubtitle || null,
        logMessage: logMessage || `妨害『${actionText}』が発動されました`,
        timestamp: Date.now() 
      },
      "gameState.subphase": nextSubphase,
      "gameState.wolfDecisionPlayerId": null,
      "gameState.wolfActionRequest": null,
      logs: arrayUnion(logData),
    };
    
    // 背水の陣が発動された場合、ドクター神拳使用不可フラグを設定
    if (actionText === "背水の陣") {
      const doctorId = Object.keys(playersObj).find((pid) => playersObj?.[pid]?.role === "doctor") || null;
      if (doctorId) {
        updates[`players.${doctorId}.resources.doctorPunchAvailableThisTurn`] = false;
      }
    }
    
    tx.update(roomRef, updates);
  });
}

/**
 * 妨害発動通知をクリア
 */
async function clearWolfActionNotification(roomId) {
  await updateDoc(doc(firestore, "rooms", roomId), {
    "gameState.wolfActionNotification": null,
  });
}

/**
 * ターン結果をクリア
 */
async function clearTurnResult(roomId) {
  await updateDoc(doc(firestore, "rooms", roomId), {
    "gameState.turnResult": null,
    "gameState.turnResultTurn": null,
  });
}

/**
 * 次のプレイヤーの挑戦開始フェーズに移行（挑戦結果ポップアップが閉じた後）
 */
async function proceedToNextPlayerChallenge(roomId) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);

  // トランザクションではなく通常の更新を使用（競合を避けるため）
  try {
    const snap = await getDoc(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    if (data?.gameState?.phase !== "playing") {
      // ゲームが進行中でない場合は何もしない
      return;
    }

    // pendingNextPlayerChallengeフラグが立っている場合のみ実行
    if (!data?.gameState?.pendingNextPlayerChallenge) {
      return; // フラグが立っていない場合は何もしない
    }

    // 次のプレイヤーの挑戦開始フェーズに移行
    await updateDoc(roomRef, {
      "gameState.subphase": "challenge_start",
      "gameState.pendingNextPlayerChallenge": null, // フラグをクリア
      "gameState.wolfDecisionPlayerId": null,
      "gameState.wolfActionRequest": null,
    });
  } catch (error) {
    // エラーが発生した場合はログに記録するが、処理を続行
    console.warn("Failed to proceed to next player challenge (may be already processed):", error);
  }
}

/**
 * 最終フェーズ：人狼を指名（ドクターのみ）
 * @param {string} roomId
 * @param {string} suspectedPlayerId - 指名されたプレイヤーのID
 */
async function identifyWolf(roomId, suspectedPlayerId) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);

  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    if (data?.gameState?.phase !== "final_phase") {
      throw new Error("Game is not in final phase");
    }

    const playersObj = data?.players || {};
    const me = playersObj?.[userId];
    if (!me || (me.role !== "doctor" && me.role !== "citizen")) {
      throw new Error("Only doctor and citizens can vote");
    }

    if (!playersObj[suspectedPlayerId]) {
      throw new Error("Suspected player not found");
    }

    // 投票データを取得・更新
    const votes = data?.gameState?.finalPhaseVotes || {};
    votes[userId] = suspectedPlayerId;

    // 市民とドクターの数をカウント
    const voters = Object.values(playersObj).filter(p => p.role === "doctor" || p.role === "citizen");
    const voterCount = voters.length;
    const majority = Math.ceil(voterCount / 2);

    // 各プレイヤーへの投票数をカウント
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

    // 全員が投票したか、過半数に達したかをチェック
    const allVoted = Object.keys(votes).length === voterCount;
    const hasMajority = !isTie && maxVotes >= majority;

    let updates = {
      "gameState.finalPhaseVotes": votes,
    };

    // 全員が投票した、または過半数に達した場合、結果を確定
    if (allVoted || hasMajority) {
      if (mostVotedPlayerId && !isTie) {
        const suspectedPlayer = playersObj[mostVotedPlayerId];
        const isWolf = suspectedPlayer?.role === "wolf";
        updates["gameState.phase"] = "finished";
        updates["gameState.gameResult"] = isWolf ? "citizen_win_reverse" : "wolf_win";
      } else {
        // 同票または過半数未満の場合は人狼勝利
        updates["gameState.phase"] = "finished";
        updates["gameState.gameResult"] = "wolf_win";
      }
    }

    tx.update(roomRef, updates);
  });
}

/**
 * 会議フェーズを開始
 * @param {string} roomId
 * @param {number} durationMinutes - 会議時間（分、デフォルト5分）
 */
async function startDiscussionPhase(roomId, durationMinutes = 5) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);

  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    const createdBy = data?.config?.createdBy;
    if (createdBy !== userId) throw new Error("Only GM can start discussion phase");

    const endTime = Date.now() + durationMinutes * 60 * 1000;

    tx.update(roomRef, {
      "gameState.discussionPhase": true,
      "gameState.discussionEndTime": endTime,
    });
  });
}

/**
 * 会議フェーズを終了して次のフェーズに進む
 * @param {string} roomId
 */
async function endDiscussionPhase(roomId) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);

  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    const createdBy = data?.config?.createdBy;
    if (createdBy !== userId) throw new Error("Only GM can end discussion phase");

    const gameState = data?.gameState || {};
    const discussionPhase = gameState.discussionPhase;

    if (!discussionPhase) {
      throw new Error("Discussion phase is not active");
    }

    const updates = {
      "gameState.discussionPhase": false,
      "gameState.discussionEndTime": null,
    };

    // 会議フェーズ後の遷移先を決定
    const pendingFinalPhase = gameState.pendingFinalPhase;
    
    // 最終フェーズ前の会議フェーズの場合、10分の会議フェーズを開始
    if (pendingFinalPhase) {
      // 10分の会議フェーズを開始
      const endTime = Date.now() + 10 * 60 * 1000;
      updates["gameState.discussionPhase"] = true;
      updates["gameState.discussionEndTime"] = endTime;
      updates["gameState.pendingFinalPhase"] = false;
      updates["gameState.pendingFinalPhaseDiscussion"] = true; // 最終フェーズ前の10分会議フラグ
      updates["gameState.turnResult"] = null;
    }
    // 最終フェーズ前の10分会議フェーズが終了した場合、最終フェーズに進む
    // ただし、doctorHasFailedがtrueの場合（ドクターが失敗し神拳で打ち消した場合）は最終フェーズに進まず人狼勝利
    else if (gameState.pendingFinalPhaseDiscussion) {
      const doctorHasFailed = gameState.doctorHasFailed === true;
      if (doctorHasFailed) {
        // ドクターが失敗した場合（神拳で打ち消した場合も含む）は最終フェーズに進まず人狼勝利
        updates["gameState.phase"] = "finished";
        updates["gameState.gameResult"] = "wolf_win";
        updates["gameState.pendingFinalPhaseDiscussion"] = false;
      } else {
        updates["gameState.phase"] = "final_phase";
        updates["gameState.finalPhaseVotes"] = {};
        updates["gameState.pendingFinalPhaseDiscussion"] = false;
      }
    }
    // ターン結果表示後の会議フェーズの場合、次のターンに進む
    else if (gameState.turnResult) {
      const maxTurns = Number(gameState.maxTurns || 5);
      const turn = Number(gameState.turn || 1);
      const whiteStars = Number(gameState.whiteStars || 0);
      const blackStars = Number(gameState.blackStars || 0);
      const majority = Math.ceil(maxTurns / 2);

      // 勝敗が決まっている場合はfinishedフェーズへ
      if (gameState.phase === "finished") {
        // そのままfinishedフェーズを維持
      }
      // 次のターンに進む（endTurnAndPrepareNextで既にターンは更新されているので、ターンは更新しない）
      else {
        // ターンは既にendTurnAndPrepareNextで更新されているので、更新しない
        const nextTurn = turn; // 既に更新済み
        const playersObj = data?.players || {};
        const order = Array.isArray(gameState.playerOrder) && gameState.playerOrder.length
          ? gameState.playerOrder
          : Object.keys(playersObj);

        updates["gameState.turn"] = nextTurn;
        updates["gameState.currentPlayerIndex"] = 0;
        updates["gameState.pendingFailure"] = null;
        updates["gameState.currentStage"] = null;
        updates["gameState.stageTurn"] = null;
        updates["gameState.subphase"] = "gm_stage";
        updates["gameState.wolfDecisionPlayerId"] = null;
        updates["gameState.wolfActionRequest"] = null;
        updates["gameState.turnResult"] = null;
        updates["gameState.pendingDoctorPunchProceed"] = null; // ドクター神拳進行フラグをクリア
        updates["gameState.wolfActionNotification"] = null; // 妨害通知をクリア

        // ドクター神拳をリセット
        const doctorId = Object.keys(playersObj).find((pid) => playersObj?.[pid]?.role === "doctor") || null;
        if (doctorId) {
          updates[`players.${doctorId}.resources.doctorPunchAvailableThisTurn`] = true;
        }
      }
    }

    tx.update(roomRef, updates);
  });
}

/**
 * 会議フェーズを2分延長
 * @param {string} roomId
 */
async function extendDiscussionPhase(roomId) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");

  const roomRef = doc(firestore, "rooms", roomId);

  await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const data = snap.data();

    const createdBy = data?.config?.createdBy;
    if (createdBy !== userId) throw new Error("Only GM can extend discussion phase");

    const gameState = data?.gameState || {};
    if (!gameState.discussionPhase) {
      throw new Error("Discussion phase is not active");
    }

    const currentEndTime = gameState.discussionEndTime || Date.now();
    const newEndTime = currentEndTime + 2 * 60 * 1000; // 2分延長

    tx.update(roomRef, {
      "gameState.discussionEndTime": newEndTime,
    });
  });
}

// generateRoomIdをグローバルにも公開（main.jsから直接使用可能にする）
if (typeof window !== 'undefined') {
  window.generateRoomId = generateRoomId;
}
