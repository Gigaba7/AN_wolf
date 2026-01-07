// ログ管理

import { $ } from "./game-state.js";
import { syncToFirebase } from "./firebase-sync.js";

function logSystem(msg) {
  addLog("system", msg);
}

function logSuccess(msg) {
  addLog("success", msg);
}

function logFail(msg) {
  addLog("fail", msg);
}

function logTurn(msg) {
  addLog("turn", msg);
}

function addLog(type, message) {
  const listEl = $("#log-list");
  if (!listEl) return;

  const item = document.createElement("div");
  item.className = `log-item log-${type}`;
  const time = new Date().toLocaleTimeString();
  item.textContent = `[${time}] ${message}`;
  listEl.appendChild(item);
  listEl.scrollTop = listEl.scrollHeight;

  // Firebase同期
  const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  if (roomId) {
    syncToFirebase('log', { 
      logType: type,
      logMessage: message,
      roomId
    }).catch(error => {
      console.error('Failed to sync log:', error);
    });
  }
}

export { logSystem, logSuccess, logFail, logTurn, addLog };
