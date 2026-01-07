// Firebase認証管理
import { signInAnonymously as firebaseSignInAnonymously, onAuthStateChanged as firebaseOnAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import { auth } from "./firebase-config.js";

let currentUser = null;
let userRole = null; // 'gm' | 'player'
let isGM = false;

/**
 * 匿名認証でログイン
 */
async function signInAnonymously() {
  try {
    const userCredential = await firebaseSignInAnonymously(auth);
    currentUser = userCredential.user;
    console.log('Signed in anonymously:', currentUser.uid);
    return currentUser;
  } catch (error) {
    console.error('Anonymous sign-in error:', error);
    throw error;
  }
}

/**
 * 現在のユーザーIDを取得
 */
function getCurrentUserId() {
  return currentUser ? currentUser.uid : null;
}

/**
 * 認証状態の監視
 */
function onAuthStateChanged(callback) {
  return firebaseOnAuthStateChanged(auth, (user) => {
    currentUser = user;
    callback(user);
  });
}

/**
 * ユーザー情報を取得
 */
function getCurrentUser() {
  return currentUser;
}

// エクスポート
export { signInAnonymously, getCurrentUserId, onAuthStateChanged, getCurrentUser };
