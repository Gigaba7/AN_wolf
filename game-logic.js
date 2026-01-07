// ゲームロジック

import { GameState } from "./game-state.js";
import { syncToFirebase } from "./firebase-sync.js";
import { renderAll } from "./ui-render.module.js";
import { logSuccess, logFail, logTurn } from "./game-logging.js";
import { checkGameEnd } from "./game-result.js";

async function onSuccess() {
  if (!GameState.players.length || GameState.resultLocked) return;
  const player = GameState.players[GameState.currentPlayerIndex];

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
    }
  }
}

async function onFail() {
  if (!GameState.players.length || GameState.resultLocked) return;
  if (GameState.pendingFailure) return; // 二重押下防止

  const idx = GameState.currentPlayerIndex;
  const player = GameState.players[idx];

  // Firebase同期
  const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  if (roomId) {
    try {
      await syncToFirebase('fail', { 
        playerName: player.name,
        roomId
      });
    } catch (error) {
      console.error('Failed to sync fail:', error);
    }
  }
}

async function onDoctorPunch() {
  if (!GameState.players.length || GameState.resultLocked) return;
  if (!GameState.pendingFailure) return;
  if (!GameState.doctorPunchAvailableThisTurn) return;
  if (GameState.doctorPunchRemaining <= 0) return;
  const player = GameState.players[GameState.currentPlayerIndex] || { name: "プレイヤー" };

  // Firebase同期
  const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  if (roomId) {
    try {
      await syncToFirebase('doctorPunch', { 
        playerName: player.name,
        roomId
      });
    } catch (error) {
      console.error('Failed to sync doctor punch:', error);
    }
  }
}

async function onWolfAction() {
  if (!GameState.players.length || GameState.resultLocked) return;
  if (GameState.wolfActionsRemaining <= 0) return;

  const { openModal } = await import("./ui-modals.js");
  openModal("wolf-roulette-modal");
}

export { onSuccess, onFail, onDoctorPunch, onWolfAction };
