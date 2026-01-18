// ゲームロジック

import { GameState } from "./game-state.js";
import { syncToFirebase } from "./firebase-sync.js";

function getOrderedCurrentPlayer() {
  const order =
    (Array.isArray(GameState.playerOrder) && GameState.playerOrder.length
      ? GameState.playerOrder
      : typeof window !== "undefined" && Array.isArray(window.RoomInfo?.gameState?.playerOrder)
      ? window.RoomInfo.gameState.playerOrder
      : null) || null;

  const currentPlayerId = order
    ? order[Math.max(0, Math.min(GameState.currentPlayerIndex, order.length - 1))]
    : GameState.players?.[GameState.currentPlayerIndex]?.id || null;

  const player = currentPlayerId ? GameState.players.find((p) => p.id === currentPlayerId) : null;
  return { player, currentPlayerId };
}

async function onSuccess() {
  // GMのみ実行可能
  const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
  const myId = typeof window !== "undefined" ? window.__uid : null;
  const isGM = !!(createdBy && myId && createdBy === myId);
  if (!isGM) {
    alert("成功/失敗の判断はGMのみが実行できます。");
    return;
  }

  if (!GameState.players.length || GameState.resultLocked) return;
  const { player } = getOrderedCurrentPlayer();
  if (!player) return;

  // Firebase同期
  const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  if (roomId) {
    try {
      await syncToFirebase('success', { 
        playerName: player.name,
        roomId
      });
    } catch (error) {
      console.error('Failed to sync success:', error);
      alert(error?.message || "成功の判断に失敗しました。");
    }
  }
}

async function onFail() {
  // GMのみ実行可能
  const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
  const myId = typeof window !== "undefined" ? window.__uid : null;
  const isGM = !!(createdBy && myId && createdBy === myId);
  if (!isGM) {
    alert("成功/失敗の判断はGMのみが実行できます。");
    return;
  }

  if (!GameState.players.length || GameState.resultLocked) return;

  const { player } = getOrderedCurrentPlayer();
  if (!player) return;
  const isConfirm = !!GameState.pendingFailure; // 失敗保留中なら「失敗確定（神拳なし）」

  // Firebase同期
  const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  if (roomId) {
    try {
      await syncToFirebase('fail', { 
        playerName: player.name,
        isConfirm,
        roomId
      });
    } catch (error) {
      console.error('Failed to sync fail:', error);
      alert(error?.message || "失敗の判断に失敗しました。");
    }
  }
}

async function onDoctorPunch() {
  console.log("[DoctorPunch] onDoctorPunch called", {
    hasPlayers: !!GameState.players.length,
    resultLocked: GameState.resultLocked,
    pendingFailure: GameState.pendingFailure,
    doctorPunchAvailableThisTurn: GameState.doctorPunchAvailableThisTurn,
    doctorPunchRemaining: GameState.doctorPunchRemaining
  });
  
  if (!GameState.players.length || GameState.resultLocked) {
    console.warn("[DoctorPunch] Early return: no players or result locked");
    return;
  }
  if (!GameState.pendingFailure) {
    console.warn("[DoctorPunch] Early return: no pending failure");
    return;
  }
  if (!GameState.doctorPunchAvailableThisTurn) {
    console.warn("[DoctorPunch] Early return: doctor punch not available this turn");
    return;
  }
  if (GameState.doctorPunchRemaining <= 0) {
    console.warn("[DoctorPunch] Early return: no doctor punch remaining");
    return;
  }

  // 神拳対象は「失敗保留中のプレイヤー」
  const targetId = GameState.pendingFailure?.playerId || null;
  const targetPlayer = targetId ? GameState.players.find((p) => p.id === targetId) : null;
  const targetName = targetPlayer?.name || "プレイヤー";

  // Firebase同期
  const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  if (roomId) {
    try {
      console.log("[DoctorPunch] Calling syncToFirebase", { roomId, targetName });
      await syncToFirebase('doctorPunch', { 
        targetPlayerName: targetName,
        roomId
      });
      console.log("[DoctorPunch] syncToFirebase completed");
    } catch (error) {
      console.error('Failed to sync doctor punch:', error);
      alert(error?.message || "ドクター神拳の送信に失敗しました。");
    }
  } else {
    console.error("[DoctorPunch] No roomId available");
  }
}

async function onDoctorSkip() {
  if (!GameState.players.length || GameState.resultLocked) return;
  if (!GameState.pendingFailure) return;

  // 神拳対象は「失敗保留中のプレイヤー」
  const targetId = GameState.pendingFailure?.playerId || null;
  const targetPlayer = targetId ? GameState.players.find((p) => p.id === targetId) : null;
  const targetName = targetPlayer?.name || "プレイヤー";

  // Firebase同期（ドクター側の「不使用」決定）
  const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  if (roomId) {
    try {
      await syncToFirebase('doctorSkip', {
        targetPlayerName: targetName,
        roomId,
      });
    } catch (error) {
      console.error('Failed to sync doctor skip:', error);
    }
  }
}

export { onSuccess, onFail, onDoctorPunch, onDoctorSkip };
