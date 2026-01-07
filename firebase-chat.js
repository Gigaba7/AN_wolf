// チャット同期（将来UIを足すだけで使えるようにAPIだけ用意）

import {
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
import { firestore } from "./firebase-config.js";
import { getCurrentUserId } from "./firebase-auth.js";

/**
 * チャット送信（rooms/{roomId}/chat サブコレクション）
 */
export async function sendChatMessage(roomId, text, meta = {}) {
  const userId = getCurrentUserId();
  if (!userId) throw new Error("User not authenticated");
  const clean = String(text || "").trim();
  if (!clean) return;

  await addDoc(collection(firestore, "rooms", roomId, "chat"), {
    text: clean,
    userId,
    createdAt: serverTimestamp(),
    ...meta, // name等を入れたい場合
  });
}

/**
 * チャット購読（最新N件）
 */
export function subscribeChat(roomId, cb, max = 50) {
  const q = query(
    collection(firestore, "rooms", roomId, "chat"),
    orderBy("createdAt", "desc"),
    limit(max)
  );

  return onSnapshot(q, (snap) => {
    const items = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const at = a.createdAt?.toMillis?.() || 0;
        const bt = b.createdAt?.toMillis?.() || 0;
        return at - bt;
      });
    cb(items);
  });
}

