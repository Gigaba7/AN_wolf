// ゲーム状態管理

/**
 * 型メモ (JSDoc)
 * @typedef {"doctor" | "wolf" | "citizen"} Role
 * @typedef {{ id:string, name:string, avatarLetter:string, avatarImage:string|null, role:Role, resources?:object }} Player
 */

// ゲーム状態
const GameState = {
  players: /** @type {Player[]} */ ([]),
  currentPlayerIndex: 0,
  playerOrder: /** @type {string[]|null} */ (null),
  turn: 1,
  maxTurns: 5,
  phase: "waiting", // waiting | revealing | playing | finished
  whiteStars: 0,
  blackStars: 0,
  wolfActionsRemaining: 5,
  doctorPunchRemaining: 5,
  doctorPunchAvailableThisTurn: true,
  pendingFailure: null, // { playerId?:string, playerIndex?:number } | null
  doctorFailed: false,
  currentStage: null,
  options: {
    sound: false,
    stageMinChapter: 2,
    stageMaxChapter: 3,
    wolfActionTexts: [
      "編成人数10人",
      "強襲ステージ",
      "推し+☆2以下編成",
      "ドクター神拳使用不可",
    ],
  },
  resultLocked: false,
};

// GameStateをグローバルに公開（firebase-sync.jsからアクセス可能にする）
if (typeof window !== 'undefined') {
  window.GameState = GameState;
}

// DOM 取得ヘルパー
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

export { GameState, $, $$ };
