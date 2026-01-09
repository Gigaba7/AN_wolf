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
      { text: "強襲作戦", cost: 20, displayName: "強襲作戦", announcementTitle: "妨害：強襲作戦(-20)", announcementSubtitle: "作戦に問題が生じたため、強襲作戦となります。(強襲作戦)", logMessage: "人狼妨害：強襲作戦" },
      { text: "ジャミング", cost: 15, displayName: "ジャミング(編成上限8名)", announcementTitle: "妨害：ジャミング(-15)", announcementSubtitle: "後援部隊との通信が妨害されました。(編成上限8名)", logMessage: "人狼妨害：ジャミング" },
      { text: "整備不良", cost: 10, requiresRoulette: true, rouletteOptions: ["先鋒", "前衛", "重装", "狙撃", "術師", "医療", "補助", "特殊"], displayName: "整備不良", announcementTitle: "妨害：整備不良(-10)", announcementSubtitle: "職分別アーツユニットの一斉点検が行われます。(ランダム職分使用禁止)", logMessage: "人狼妨害：整備不良" },
      { text: "背水の陣", cost: 30, displayName: "背水の陣", announcementTitle: "妨害：背水の陣(-30)", announcementSubtitle: "ドクターは連日の激務により本来の力が出せないようです。(ドクター神拳使用不可)", logMessage: "人狼妨害：背水の陣" },
      { text: "補給遮断", cost: 15, displayName: "補給遮断", announcementTitle: "妨害：補給遮断(-15)", announcementSubtitle: "補給部隊と連絡が取れません。(再配置禁止)", logMessage: "人狼妨害：補給遮断" },
      { text: "工作", cost: 10, displayName: "工作", announcementTitle: "妨害：工作(-10)", announcementSubtitle: "工作員によりアーツユニットが正常に動作しません(手動スキル使用禁止)", logMessage: "人狼妨害：工作" },
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
