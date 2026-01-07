// RoomClient: 同期処理を「デフォルト」にする薄いAPI層
// - ルーム購読（subscribe）
// - アクション送信（dispatch）
// - 将来チャット（subcollection）も同じパターンで追加可能

import { signInAnonymously, getCurrentUser } from "./firebase-auth.js";

/** @typedef {(roomData:any)=>void} RoomCallback */

/**
 * @param {{
 *  getRoomId: ()=>string|null,
 *  setRoomId: (id:string|null)=>void,
 *  subscribe: (roomId:string, cb:RoomCallback)=>()=>void,
 *  handlers: Record<string,(roomId:string, payload:any)=>Promise<void>>
 * }} deps
 */
export function createRoomClient(deps) {
  /** @type {null|(()=>void)} */
  let unsubscribe = null;

  async function ensureAuth() {
    if (!getCurrentUser()) {
      await signInAnonymously();
    }
  }

  function getRoomId() {
    return deps.getRoomId();
  }

  function setRoomId(id) {
    deps.setRoomId(id);
  }

  function start(roomId, onRoomData) {
    if (unsubscribe) unsubscribe();
    setRoomId(roomId);
    unsubscribe = deps.subscribe(roomId, onRoomData);
    return unsubscribe;
  }

  function stop() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    setRoomId(null);
  }

  async function dispatch(action, payload = {}) {
    await ensureAuth();
    const roomId = payload.roomId || getRoomId();
    if (!roomId) return;
    const handler = deps.handlers[action];
    if (!handler) throw new Error(`Unknown action: ${action}`);
    await handler(roomId, payload);
  }

  return { ensureAuth, getRoomId, setRoomId, start, stop, dispatch };
}

