// ゲームロジック

import { GameState } from "./game-state.js";
import { syncToFirebase } from "./firebase-sync.js";
import { renderAll } from "./ui-render.js";
import { logSuccess, logFail, logTurn } from "./game-logging.js";
import { checkGameEnd } from "./game-result.js";

async function onNextPlayer() {
  if (!GameState.players.length) return;

  const currentIndex = GameState.currentPlayerIndex;
  const nextIndex = (currentIndex + 1) % GameState.players.length;
  GameState.currentPlayerIndex = nextIndex;

  // Firebase同期
  const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  if (roomId) {
    try {
      await syncToFirebase('nextPlayer', { 
        newPlayerIndex: nextIndex,
        roomId
      });
    } catch (error) {
      console.error('Failed to sync next player:', error);
    }
  }

  renderAll();
  logTurn(`次のプレイヤー: ${GameState.players[nextIndex].name}`);
}

async function onSuccess() {
  if (!GameState.players.length || GameState.resultLocked) return;

  GameState.whiteStars += 1;
  const player = GameState.players[GameState.currentPlayerIndex];

  // Firebase同期
  const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  if (roomId) {
    try {
      await syncToFirebase('success', { 
        playerName: player.name,
        newWhiteStars: GameState.whiteStars,
        logMessage: `${player.name} がステージ攻略に成功しました。`,
        roomId
      });
    } catch (error) {
      console.error('Failed to sync success:', error);
    }
  }

  logSuccess(`${player.name} がステージ攻略に成功しました。`);
  checkGameEnd();
  renderAll();

  // 自動で次のプレイヤーへ
  onNextPlayer();
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
        playerIndex: idx,
        roomId
      });
    } catch (error) {
      console.error('Failed to sync fail:', error);
    }
  }

  GameState.pendingFailure = { playerIndex: idx };
  logFail(`${player.name} がステージ攻略に失敗しました。ドクター神拳が使用可能です。`);

  renderAll();
}

async function onDoctorPunch() {
  if (!GameState.players.length || GameState.resultLocked) return;
  if (!GameState.pendingFailure) return;
  if (!GameState.doctorPunchAvailableThisTurn) return;
  if (GameState.doctorPunchRemaining <= 0) return;

  const { playerIndex } = GameState.pendingFailure;
  const player = GameState.players[playerIndex];

  // Firebase同期
  const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  if (roomId) {
    try {
      await syncToFirebase('doctorPunch', { 
        playerName: player.name,
        newDoctorPunchRemaining: GameState.doctorPunchRemaining - 1,
        doctorPunchAvailableThisTurn: false,
        logMessage: `ドクター神拳発動！ ${player.name} の失敗はなかったことになりました。`,
        roomId
      });
    } catch (error) {
      console.error('Failed to sync doctor punch:', error);
    }
  }

  GameState.doctorPunchRemaining -= 1;
  GameState.doctorPunchAvailableThisTurn = false;
  GameState.pendingFailure = null;

  const { logSystem } = await import("./game-logging.js");
  logSystem(`ドクター神拳発動！ ${player.name} の失敗はなかったことになりました。`);
  renderAll();
}

async function onWolfAction() {
  if (!GameState.players.length || GameState.resultLocked) return;
  if (GameState.wolfActionsRemaining <= 0) return;

  const { openModal } = await import("./ui-modals.js");
  openModal("wolf-roulette-modal");
}

export { onNextPlayer, onSuccess, onFail, onDoctorPunch, onWolfAction };
