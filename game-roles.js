// 役職管理

import { updateGameState as updateGameStateDB } from "./firebase-db.js";

/**
 * 役職を割り当て
 */
function assignRoles(players) {
  const count = players.length;
  if (count < 3 || count > 8) return;

  // 役職をリセット
  players.forEach((p) => (p.role = null));

  // 1人狼 + 残り市民（3人以上なら1ドクター）
  const roles = ["wolf"];
  if (count >= 3) {
    roles.push("doctor");
  }
  for (let i = roles.length; i < count; i++) {
    roles.push("citizen");
  }

  // シャッフル
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  // 割り当て
  players.forEach((p, idx) => {
    p.role = roles[idx];
  });
}

/**
 * 役職をFirebaseに保存
 */
async function saveRolesToFirebase(roomId, players) {
  const updates = {};
  players.forEach((player) => {
    if (player.id && player.role) {
      updates[`players.${player.id}.role`] = player.role;
    }
  });
  
  if (Object.keys(updates).length > 0) {
    await updateGameStateDB(roomId, updates);
  }
}

/**
 * 待機状態からゲーム開始状態に変更
 */
async function updateGameStateFromWaiting(roomId) {
  await updateGameStateDB(roomId, {
    'gameState.phase': 'playing',
  });
}

export { assignRoles, saveRolesToFirebase, updateGameStateFromWaiting };
