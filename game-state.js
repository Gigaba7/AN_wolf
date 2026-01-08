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
  phase: "waiting", // waiting | revealing | playing | final_phase | finished
  subphase: null, // wolf_decision | wolf_resolving | gm_stage | await_result | await_doctor | null
  whiteStars: 0,
  blackStars: 0,
  wolfActionsRemaining: 100, // 総コスト100
  doctorPunchRemaining: 5,
  doctorPunchAvailableThisTurn: true,
  pendingFailure: null, // { playerId?:string, playerIndex?:number } | null
  doctorHasFailed: false, // ドクターが一度でも失敗したか（神拳で打ち消しても失敗として記録）
  currentStage: null,
  options: {
    sound: false,
    stageMinChapter: 2,
    stageMaxChapter: 3,
    // 妨害データ構造: {text: string, cost: number, requiresRoulette?: boolean, rouletteOptions?: string[]}[]
    // requiresRoulette: trueの場合、GM画面でルーレットを実行する必要がある
    wolfActions: [
      { text: "強襲作戦", cost: 40 },
      { text: "編成上限8名", cost: 25 },
      { text: "ランダム職業使用禁止", cost: 30, requiresRoulette: true, rouletteOptions: ["先鋒", "前衛", "重装", "狙撃", "術師", "医療", "補助", "特殊"] },
      { text: "ドクター神拳使用不可", cost: 50 },
      { text: "再配置禁止", cost: 35 },
      { text: "手動スキル使用禁止", cost: 20 },
    ],
    // 後方互換性のため（既存データ用）
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
