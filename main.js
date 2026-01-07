// アークナイツ人狼 GM ツール ロジック

/**
 * 型メモ (JSDoc)
 * @typedef {"doctor" | "wolf" | "citizen"} Role
 * @typedef {{ id:number, name:string, avatarLetter:string, role:Role }} Player
 */

// ゲーム状態
const GameState = {
  players: /** @type {Player[]} */ ([]),
  currentPlayerIndex: 0,
  turn: 1,
  maxTurns: 5,
  whiteStars: 0,
  blackStars: 0,
  wolfActionsRemaining: 5,
  doctorPunchRemaining: 5,
  doctorPunchAvailableThisTurn: true,
  pendingFailure: null, // { playerIndex:number } | null
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

// DOM 取得
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Firebaseモジュールのインポート
import { onAuthStateChanged, signInAnonymously, getCurrentUser } from "./firebase-auth.js";
import { createRoomAndStartGame, joinRoomAndSync, syncToFirebase } from "./firebase-sync.js";

document.addEventListener("DOMContentLoaded", async () => {
  // 認証状態を監視
  onAuthStateChanged((user) => {
    if (user) {
      console.log('User authenticated:', user.uid);
    }
  });
  
  // 匿名認証でログイン
  try {
    await signInAnonymously();
  } catch (error) {
    console.error('Failed to sign in:', error);
  }
  
  setupHomeScreen();
  setupMainScreen();
  setupModals();
  logSystem("ツールが起動しました。ホーム画面からプレイヤーを設定してください。");
});

// ---------------- ホーム画面 ----------------
function setupHomeScreen() {
  const optBtn = $("#open-options");
  const tosBtn = $("#open-tos");

  optBtn?.addEventListener("click", () => openModal("options-modal"));
  tosBtn?.addEventListener("click", () => openModal("tos-modal"));
  
  // ルーム作成/参加ボタン
  $("#btn-create-room")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('ルーム作成ボタンがクリックされました');
    
    const joinForm = $("#join-room-form");
    const roomInfo = $("#room-info");
    const createForm = $("#create-room-form");
    
    console.log('フォーム要素:', { joinForm, roomInfo, createForm });
    
    if (joinForm) {
      joinForm.style.display = "none";
      console.log('参加フォームを非表示にしました');
    }
    if (roomInfo) {
      roomInfo.style.display = "none";
      console.log('ルーム情報を非表示にしました');
    }
    if (createForm) {
      createForm.style.display = "block";
      console.log('作成フォームを表示しました');
    } else {
      console.error('create-room-form要素が見つかりません');
    }
  });
  
  $("#btn-create-room-confirm")?.addEventListener("click", async () => {
    const hostNameInput = $("#host-name-input");
    if (!hostNameInput) return;
    
    const hostName = hostNameInput.value.trim();
    if (!hostName) {
      alert("名前を入力してください。");
      return;
    }
    
    try {
      let currentUser = getCurrentUser();
      if (!currentUser) {
        console.log('Signing in anonymously for room creation...');
        await signInAnonymously();
        currentUser = getCurrentUser();
        if (!currentUser) {
          throw new Error('認証に失敗しました');
        }
      }
      
      console.log('Creating room for host:', hostName);
      
      // ルームを作成（ホストとして）
      const roomId = await createRoomAndStartGame([], {
        hostName: hostName,
        maxPlayers: 8,
        stageMinChapter: GameState.options.stageMinChapter,
        stageMaxChapter: GameState.options.stageMaxChapter,
        wolfActionTexts: GameState.options.wolfActionTexts,
      });
      
      console.log('Room created successfully with ID:', roomId);
      
      // ルームIDをグローバルに保存
      if (typeof window !== 'undefined' && window.setCurrentRoomId) {
        window.setCurrentRoomId(roomId);
      }
      
      // ルームIDを表示
      const roomIdDisplay = $("#room-id-display");
      if (roomIdDisplay) {
        roomIdDisplay.textContent = roomId;
      }
      const roomInfo = $("#room-info");
      if (roomInfo) {
        roomInfo.style.display = "block";
      }
      $("#create-room-form")?.style.setProperty("display", "none");
      
      // メイン画面に切り替え
      switchScreen("home-screen", "main-screen");
      renderAll();
      
      console.log('Room ID displayed:', roomId);
    } catch (error) {
      console.error('Failed to create room:', error);
      const errorMessage = error.message || '不明なエラーが発生しました';
      alert('ルーム作成に失敗しました:\n\n' + errorMessage + '\n\n詳細はブラウザのコンソール（F12）を確認してください。');
    }
  });
  
  // ルーム作成フォームでEnterキーを押したときも作成
  $("#host-name-input")?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      $("#btn-create-room-confirm")?.click();
    }
  });
  
  $("#btn-join-room")?.addEventListener("click", () => {
    $("#join-room-form")?.style.setProperty("display", "block");
    $("#room-info")?.style.setProperty("display", "none");
  });
  
  $("#btn-join-room-confirm")?.addEventListener("click", async () => {
    const roomIdInput = $("#room-id-input");
    const playerNameInput = $("#player-name-input");
    
    if (!roomIdInput || !playerNameInput) return;
    
    const roomId = roomIdInput.value.trim().toUpperCase();
    if (!roomId || roomId.length !== 6) {
      alert("ルームIDは6文字です。");
      return;
    }
    
    const playerName = playerNameInput.value.trim();
    if (!playerName) {
      alert("名前を入力してください。");
      return;
    }
    
    try {
      await joinRoomAndSync(roomId, playerName);
      // 参加後はメイン画面に切り替え
      switchScreen("home-screen", "main-screen");
      renderAll();
    } catch (error) {
      alert("ルームへの参加に失敗しました: " + error.message);
    }
  });
  
  // ルームID入力欄でEnterキーを押したときも参加
  $("#room-id-input")?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      $("#btn-join-room-confirm")?.click();
    }
  });
  
  // プレイヤー名入力欄でEnterキーを押したときも参加
  $("#player-name-input")?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      $("#btn-join-room-confirm")?.click();
    }
  });
  
  $("#btn-copy-room-id")?.addEventListener("click", () => {
    const roomIdDisplay = $("#room-id-display");
    if (roomIdDisplay && roomIdDisplay.textContent) {
      const roomId = roomIdDisplay.textContent;
      navigator.clipboard.writeText(roomId).then(() => {
        alert("ルームIDをコピーしました: " + roomId);
      }).catch(() => {
        // フォールバック
        const textarea = document.createElement("textarea");
        textarea.value = roomId;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        alert("ルームIDをコピーしました: " + roomId);
      });
    }
  });
}

// プレイヤー設定は各自が参加時に入力するため、ホーム画面での設定機能は削除
// オフライン機能も削除（Firebase必須）

function showRoleConfirmationModal(players) {
  const modal = $("#role-confirmation-modal");
  const listEl = $("#role-confirmation-list");
  if (!modal || !listEl) return;

  listEl.innerHTML = "";
  players.forEach((p) => {
    const roleLabel =
      p.role === "doctor"
        ? "ドクター"
        : p.role === "wolf"
        ? "レユニオン(人狼)"
        : "市民";

    const roleClass =
      p.role === "doctor"
        ? "role-doctor"
        : p.role === "wolf"
        ? "role-wolf"
        : "role-citizen";

    const item = document.createElement("div");
    item.className = "role-confirmation-item";
    item.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px;">
        <div class="player-avatar"><span>${p.avatarLetter}</span></div>
        <div style="flex: 1;">
          <div style="font-weight: 500; font-size: 14px;">${p.name}</div>
        </div>
        <span class="player-role-tag ${roleClass}">${roleLabel}</span>
      </div>
    `;
    listEl.appendChild(item);
  });

  // ゲーム開始ボタンのイベントリスナー
  const startBtn = $("#role-confirmation-start");
  if (startBtn) {
    startBtn.onclick = () => {
      closeModal("role-confirmation-modal");
      switchScreen("home-screen", "main-screen");
      renderAll();
      logSystem(
        `ゲーム開始。プレイヤー数: ${players.length}人 / 役職はランダムに割り当てられました。(GMのみ閲覧想定)`
      );
      logTurn(`ターン1開始`);
    };
  }

  openModal("role-confirmation-modal");
}

function assignRoles(players) {
  const count = players.length;
  if (count < 3) return;
  const doctorIndex = Math.floor(Math.random() * count);
  let wolfIndex;
  do {
    wolfIndex = Math.floor(Math.random() * count);
  } while (wolfIndex === doctorIndex);

  players.forEach((p, i) => {
    if (i === doctorIndex) p.role = "doctor";
    else if (i === wolfIndex) p.role = "wolf";
    else p.role = "citizen";
  });
}

// ---------------- メイン画面 ----------------
function setupMainScreen() {
  $("#btn-next-player")?.addEventListener("click", onNextPlayer);
  $("#btn-success")?.addEventListener("click", onSuccess);
  $("#btn-fail")?.addEventListener("click", onFail);
  $("#btn-wolf-action")?.addEventListener("click", onWolfAction);
  $("#btn-doctor-punch")?.addEventListener("click", onDoctorPunch);

  $("#clear-log")?.addEventListener("click", () => {
    const logList = $("#log-list");
    if (logList) logList.innerHTML = "";
  });

  // ステージ選出ボタンは削除されました
  $("#main-options-btn")?.addEventListener("click", () =>
    openModal("options-modal")
  );
}

function onNextPlayer() {
  if (!GameState.players.length || GameState.resultLocked) return;

  if (GameState.pendingFailure) {
    // 失敗を確定させてターン終了
    commitFailureAndEndTurn(GameState.pendingFailure.playerIndex);
    GameState.pendingFailure = null;
    renderAll();
    return;
  }

  const prevIndex = GameState.currentPlayerIndex;
  const nextIndex = (prevIndex + 1) % GameState.players.length;

  // 一周したらターン終了 -> 全員成功した扱いで白星
  if (nextIndex === 0) {
    endTurnWithWhiteStar();
  } else {
    GameState.currentPlayerIndex = nextIndex;
    logSystem(
      `次のプレイヤー: ${GameState.players[GameState.currentPlayerIndex].name}`
    );
  }
  renderAll();
}

async function onSuccess() {
  if (!GameState.players.length || GameState.resultLocked) return;
  if (GameState.pendingFailure) return; // 処理待ち中は無効

  const player = GameState.players[GameState.currentPlayerIndex];
  
  // Firebase同期
  const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  if (roomId) {
    try {
      await syncToFirebase('success', { playerName: player.name, roomId });
    } catch (error) {
      console.error('Failed to sync success:', error);
    }
  }
  
  logSuccess(`${player.name} がステージを攻略しました。`);

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
      await syncToFirebase('doctorPunch', { playerName: player.name, roomId });
    } catch (error) {
      console.error('Failed to sync doctor punch:', error);
    }
  }

  GameState.doctorPunchRemaining -= 1;
  GameState.doctorPunchAvailableThisTurn = false;
  GameState.pendingFailure = null;

  logSystem(
    `ドクター神拳発動！ ${player.name} の失敗はなかったことになりました。(残り${GameState.doctorPunchRemaining}回)`
  );

  // 失敗はキャンセル → 成功扱いとして次へ
  onNextPlayer();
  renderAll();
}

function onWolfAction() {
  if (!GameState.players.length || GameState.resultLocked) return;
  if (GameState.wolfActionsRemaining <= 0) {
    alert("人狼妨害の残り回数がありません。");
    return;
  }

  // 1ターンに1回制限: ログから判定 (簡易)
  const logList = $("#log-list");
  if (logList) {
    const usedThisTurn = Array.from(logList.children).some((el) =>
      el.textContent?.includes(`T${GameState.turn} 妨害`)
    );
    if (usedThisTurn) {
      alert("このターンではすでに人狼妨害が使用されています。");
      return;
    }
  }

  openWolfRoulette();
}

function commitFailureAndEndTurn(playerIndex) {
  const player = GameState.players[playerIndex];

  GameState.blackStars += 1;
  logFail(
    `${player.name} の失敗が確定しました。黒星が1つ追加されます。(黒星: ${GameState.blackStars})`
  );

  if (player.role === "doctor") {
    GameState.doctorFailed = true;
    // 即時人狼勝利
    logFail("ドクターに黒星が付きました。人狼陣営の勝利です。");
    showResult("人狼陣営の勝利", "ドクターの黒星により即時決着となりました。");
    GameState.resultLocked = true;
    return;
  }

  proceedTurnEnd();
}

function endTurnWithWhiteStar() {
  GameState.whiteStars += 1;
  logSuccess(`全員がステージを攻略しました。白星が1つ追加されます。(白星: ${GameState.whiteStars})`);
  proceedTurnEnd();
}

function proceedTurnEnd() {
  // 勝敗チェック
  if (checkAndHandleGameEnd()) {
    return;
  }

  // ターンを進める
  if (GameState.turn < GameState.maxTurns) {
    GameState.turn += 1;
    GameState.currentPlayerIndex = 0;
    GameState.doctorPunchAvailableThisTurn = true;
    GameState.pendingFailure = null;
    GameState.currentStage = null;

    logTurn(`ターン${GameState.turn}開始`);
  } else {
    // 5ターン目終了後に最終判定
    finalizeGameIfNeeded();
  }
}

function checkAndHandleGameEnd() {
  const required = Math.floor(GameState.maxTurns / 2) + 1; // 3

  if (GameState.whiteStars >= required || GameState.blackStars >= required) {
    finalizeGameIfNeeded();
    return GameState.resultLocked;
  }
  return false;
}

function finalizeGameIfNeeded() {
  if (GameState.resultLocked) return;

  const { whiteStars, blackStars } = GameState;

  if (whiteStars > blackStars) {
    logSuccess("最終結果: 白星が過半数のため、市民陣営の勝利です。");
    showResult("市民陣営の勝利", `白星 ${whiteStars} / 黒星 ${blackStars} で決着しました。`);
    GameState.resultLocked = true;
    return;
  }

  if (blackStars > whiteStars) {
    // 一般判定では人狼勝利。ただしドクターが一度も失敗していなければ、指名チャンス
    if (!GameState.doctorFailed) {
      logTurn(
        "黒星が過半数ですが、ドクターは一度も失敗していません。人狼を指名できれば逆転勝利です。"
      );
      showGuessWolfModal();
    } else {
      logFail("最終結果: 黒星が過半数のため、人狼陣営の勝利です。");
      showResult(
        "人狼陣営の勝利",
        `白星 ${whiteStars} / 黒星 ${blackStars}。ドクターにも黒星があるため逆転条件は満たされません。`
      );
      GameState.resultLocked = true;
    }
    return;
  }

  // 引き分けは市民優勢 (任意判断)
  logSystem("白星と黒星が同数のため、市民側優勢として扱います。");
  showResult(
    "市民陣営の勝利 (同数判定)",
    `白星 ${whiteStars} / 黒星 ${blackStars} で同数でした。`
  );
  GameState.resultLocked = true;
}

// ---------------- ルーレット ----------------
function openStageRoulette() {
  const modalId = "stage-roulette-modal";
  const container = $("#stage-roulette-items");
  if (!container) return;

  container.innerHTML = "";
  const candidates = buildStageCandidates();
  candidates.forEach((name) => {
    const div = document.createElement("div");
    div.className = "roulette-item";
    div.textContent = name;
    container.appendChild(div);
  });

  openModal(modalId);

  const startBtn = $("#stage-roulette-start");
  if (!startBtn) return;
  startBtn.disabled = false;
  startBtn.onclick = async () => {
    startBtn.disabled = true;
    runRoulette(container, async (chosen) => {
      // Firebase同期
      const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
      if (roomId && typeof syncToFirebase === 'function') {
        try {
          await syncToFirebase('stageRoulette', {
            stage: chosen,
            stages: buildStageCandidates(),
            roomId: typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null,
          });
        } catch (error) {
          console.error('Failed to sync stage roulette:', error);
        }
      }
      
      GameState.currentStage = chosen;
      logSystem(`今ターンのステージは「${chosen}」に決まりました。`);
      renderStatus();
    });
  };
}

function openWolfRoulette() {
  const modalId = "wolf-roulette-modal";
  const container = $("#wolf-roulette-items");
  if (!container) return;

  container.innerHTML = "";
  const items =
    GameState.options.wolfActionTexts && GameState.options.wolfActionTexts.length
      ? GameState.options.wolfActionTexts
      : ["編成人数10人", "強襲ステージ", "推し+☆2以下編成", "ドクター神拳使用不可"];

  items.forEach((name) => {
    const div = document.createElement("div");
    div.className = "roulette-item";
    div.textContent = name;
    container.appendChild(div);
  });

  openModal(modalId);

  const startBtn = $("#wolf-roulette-start");
  if (!startBtn) return;
  startBtn.disabled = false;
  startBtn.onclick = async () => {
    startBtn.disabled = true;
    runRoulette(container, async (chosen) => {
      // Firebase同期
      const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
      if (roomId && typeof syncToFirebase === 'function') {
        try {
          await syncToFirebase('wolfAction', {
            action: chosen,
            options: items,
            roomId: typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null,
          });
        } catch (error) {
          console.error('Failed to sync wolf action:', error);
        }
      }
      
      GameState.wolfActionsRemaining -= 1;
      logTurn(
        `T${GameState.turn} 妨害: 「${chosen}」が発動されました。(残り${GameState.wolfActionsRemaining}回)`
      );
      renderStatus();
    });
  };
}

/**
 * @param {HTMLElement} container
 * @param {(chosen:string)=>void} onFinish
 */
function runRoulette(container, onFinish) {
  const items = Array.from(container.querySelectorAll(".roulette-item"));
  if (!items.length) {
    onFinish("なし");
    return;
  }

  let index = 0;
  let cycles = 0;
  const totalCycles = 20 + Math.floor(Math.random() * 10);

  const timer = setInterval(() => {
    items.forEach((el) => el.classList.remove("active", "final"));
    items[index].classList.add("active");
    index = (index + 1) % items.length;
    cycles += 1;

    if (cycles >= totalCycles) {
      clearInterval(timer);
      const finalIndex = (index + items.length - 1) % items.length;
      items.forEach((el) => el.classList.remove("active", "final"));
      const finalItem = items[finalIndex];
      finalItem.classList.add("final");
      const chosen = finalItem.textContent || "";
      setTimeout(() => {
        closeAllRouletteModals();
        onFinish(chosen);
      }, 800);
    }
  }, 80);
}

function buildStageCandidates() {
  const min = GameState.options.stageMinChapter;
  const max = GameState.options.stageMaxChapter;
  const list = [];
  for (let ch = min; ch <= max; ch++) {
    for (let i = 1; i <= 8; i++) {
      list.push(`${ch}-${i}`);
    }
  }
  return list;
}

// ---------------- オプション / モーダル ----------------
function setupModals() {
  // モーダル共通クローズ
  document.body.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const closeId = target.getAttribute("data-close-modal");
    if (closeId) {
      closeModal(closeId);
    }
  });

  // オプションの初期値
  const soundEl = $("#opt-sound");
  const minEl = $("#opt-stage-min");
  const maxEl = $("#opt-stage-max");
  const wolfEl = $("#opt-wolf-actions");

  if (soundEl instanceof HTMLInputElement) {
    soundEl.checked = GameState.options.sound;
  }
  if (minEl instanceof HTMLSelectElement) {
    minEl.value = String(GameState.options.stageMinChapter);
  }
  if (maxEl instanceof HTMLSelectElement) {
    maxEl.value = String(GameState.options.stageMaxChapter);
  }
  if (wolfEl instanceof HTMLTextAreaElement) {
    wolfEl.value = GameState.options.wolfActionTexts.join("\n");
  }

  $("#opt-save")?.addEventListener("click", () => {
    if (soundEl instanceof HTMLInputElement) {
      GameState.options.sound = soundEl.checked;
    }
    if (minEl instanceof HTMLSelectElement && maxEl instanceof HTMLSelectElement) {
      const min = Number(minEl.value);
      const max = Number(maxEl.value);
      if (min > max) {
        alert("ステージ範囲の最小章は最大章より大きくできません。");
        return;
      }
      GameState.options.stageMinChapter = min;
      GameState.options.stageMaxChapter = max;
    }
    if (wolfEl instanceof HTMLTextAreaElement) {
      const lines = wolfEl.value
        .split("\n")
        .map((v) => v.trim())
        .filter(Boolean);
      if (lines.length) {
        GameState.options.wolfActionTexts = lines;
      }
    }
    closeModal("options-modal");
    logSystem("オプションを保存しました。");
  });

  $("#opt-back-home")?.addEventListener("click", () => {
    closeModal("options-modal");
    switchScreen("main-screen", "home-screen");
  });

  $("#opt-open-tos")?.addEventListener("click", () => openModal("tos-modal"));
  $("#open-tos")?.addEventListener("click", () => openModal("tos-modal"));
  $("#result-reset")?.addEventListener("click", () => location.reload());
}

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("hidden");
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("hidden");
}

function closeAllRouletteModals() {
  closeModal("stage-roulette-modal");
  closeModal("wolf-roulette-modal");
}

function switchScreen(fromId, toId) {
  const from = document.getElementById(fromId);
  const to = document.getElementById(toId);
  from?.classList.remove("active");
  to?.classList.add("active");
}

// ---------------- 描画 ----------------
function renderAll() {
  renderStatus();
  renderPlayers();
  renderCurrentInfo();
  renderControls();
}

function renderStatus() {
  const turnEl = $("#status-turn");
  const starsEl = $("#status-stars");
  const wolfEl = $("#status-wolf-remaining");
  const wolfBtnEl = $("#wolf-remaining-in-button");
  const docFlagEl = $("#status-doctor-flag");
  const docRemainEl = $("#status-doctor-remaining");
  const stageEl = $("#status-stage");

  if (turnEl) {
    turnEl.textContent = `${GameState.turn} / ${GameState.maxTurns}`;
  }

  if (starsEl) {
    const whites = "○".repeat(GameState.whiteStars);
    const blacks = "×".repeat(GameState.blackStars);
    const rest = "・".repeat(
      Math.max(0, GameState.maxTurns - GameState.whiteStars - GameState.blackStars)
    );
    starsEl.textContent = whites + blacks + rest;
  }

  if (wolfEl) {
    wolfEl.textContent = `${GameState.wolfActionsRemaining} / 5`;
  }
  
  if (wolfBtnEl) {
    wolfBtnEl.textContent = `(残り ${GameState.wolfActionsRemaining} 回)`;
  }

  if (docFlagEl) {
    docFlagEl.textContent = GameState.doctorPunchAvailableThisTurn
      ? "使用可能"
      : "使用済み";
    docFlagEl.classList.toggle(
      "status-pill-on",
      GameState.doctorPunchAvailableThisTurn
    );
    docFlagEl.classList.toggle(
      "status-pill-off",
      !GameState.doctorPunchAvailableThisTurn
    );
  }

  if (docRemainEl) {
    docRemainEl.textContent = `残り ${GameState.doctorPunchRemaining} 回`;
  }

  if (stageEl) {
    stageEl.textContent = GameState.currentStage || "未選出";
  }
}

function renderPlayers() {
  const listEl = $("#players-list");
  if (!listEl) return;

  listEl.innerHTML = "";
  GameState.players.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "player-card";
    if (i === GameState.currentPlayerIndex) card.classList.add("current");

    // 役職は表示しない（ゲーム中は内部情報のみ）
    const avatarContent = p.avatarImage
      ? `<img src="${p.avatarImage}" alt="${p.name}" class="player-avatar-img" />`
      : `<span>${p.avatarLetter}</span>`;
    
    card.innerHTML = `
      <div class="player-avatar">${avatarContent}</div>
      <div class="player-meta">
        <div class="player-name">${p.name}</div>
      </div>
    `;

    listEl.appendChild(card);
  });
}

function renderCurrentInfo() {
  // 攻略中プレイヤーと対象ステージの表示は削除されました
}

function renderControls() {
  const btnNext = $("#btn-next-player");
  const btnSuccess = $("#btn-success");
  const btnFail = $("#btn-fail");
  const btnWolf = $("#btn-wolf-action");
  const btnDoc = $("#btn-doctor-punch");

  const gameActive = GameState.players.length > 0 && !GameState.resultLocked;

  if (btnNext) btnNext.disabled = !gameActive;
  if (btnSuccess) btnSuccess.disabled = !gameActive || !!GameState.pendingFailure;
  if (btnFail) btnFail.disabled = !gameActive || !!GameState.pendingFailure;
  if (btnWolf) btnWolf.disabled = !gameActive || GameState.wolfActionsRemaining <= 0;
  if (btnDoc) {
    btnDoc.disabled =
      !gameActive ||
      !GameState.pendingFailure ||
      !GameState.doctorPunchAvailableThisTurn ||
      GameState.doctorPunchRemaining <= 0;
  }
}

// ---------------- ログ ----------------
function appendLog(text, className) {
  const list = $("#log-list");
  if (!list) return;
  const div = document.createElement("div");
  div.className = "log-entry " + (className || "");
  const time = new Date();
  const t =
    time.getHours().toString().padStart(2, "0") +
    ":" +
    time.getMinutes().toString().padStart(2, "0");
  div.textContent = `[${t}] ${text}`;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

function logSystem(text) {
  appendLog(text, "system");
}

function logSuccess(text) {
  appendLog(text, "success");
}

function logFail(text) {
  appendLog(text, "fail");
}

function logTurn(text) {
  appendLog(text, "turn");
}

// ---------------- 結果・人狼指名 ----------------
function showResult(title, summary) {
  const titleEl = $("#result-title");
  const sumEl = $("#result-summary");
  const extraEl = $("#result-extra");
  const rolesEl = $("#result-roles");
  if (titleEl) titleEl.textContent = title;
  if (sumEl) sumEl.textContent = summary;
  if (extraEl) extraEl.textContent = "";
  
  // ゲーム終了後の役職表示
  if (rolesEl) {
    rolesEl.innerHTML = "";
    const rolesTitle = document.createElement("h3");
    rolesTitle.textContent = "役職一覧";
    rolesTitle.style.marginTop = "16px";
    rolesTitle.style.marginBottom = "8px";
    rolesTitle.style.fontSize = "14px";
    rolesEl.appendChild(rolesTitle);
    
    const rolesList = document.createElement("div");
    rolesList.style.display = "flex";
    rolesList.style.flexDirection = "column";
    rolesList.style.gap = "6px";
    
    GameState.players.forEach((p) => {
      const roleLabel =
        p.role === "doctor"
          ? "ドクター"
          : p.role === "wolf"
          ? "レユニオン(人狼)"
          : "市民";
      
      const roleClass =
        p.role === "doctor"
          ? "role-doctor"
          : p.role === "wolf"
          ? "role-wolf"
          : "role-citizen";
      
      const roleItem = document.createElement("div");
      roleItem.style.display = "flex";
      roleItem.style.alignItems = "center";
      roleItem.style.gap = "8px";
      roleItem.style.padding = "6px 8px";
      roleItem.style.borderRadius = "6px";
      roleItem.style.background = "rgba(255, 255, 255, 0.03)";
      roleItem.innerHTML = `
        <span style="font-weight: 500;">${p.name}</span>
        <span class="player-role-tag ${roleClass}" style="margin-left: auto;">${roleLabel}</span>
      `;
      rolesList.appendChild(roleItem);
    });
    
    rolesEl.appendChild(rolesList);
  }
  
  openModal("result-modal");
}

function showGuessWolfModal() {
  const extraEl = $("#result-extra");
  if (!extraEl) return;

  const wolves = GameState.players.filter((p) => p.role === "wolf");
  const realWolf = wolves[0];

  extraEl.innerHTML = "";
  const info = document.createElement("p");
  info.textContent =
    "GMは各プレイヤーからの投票結果に応じて、人狼だと思うプレイヤーを1名選択してください。";
  extraEl.appendChild(info);

  const btnWrap = document.createElement("div");
  btnWrap.style.display = "flex";
  btnWrap.style.flexWrap = "wrap";
  btnWrap.style.gap = "6px";
  btnWrap.style.marginTop = "8px";

  GameState.players.forEach((p) => {
    const b = document.createElement("button");
    b.className = "btn ghost small";
    b.textContent = p.name;
    b.addEventListener("click", () => {
      const isWolf = p.id === realWolf.id;
      if (isWolf) {
        logSuccess(`人狼指名成功！ ${p.name} がレユニオン人狼でした。`);
        showResult(
          "市民陣営の逆転勝利",
          `黒星が過半数でしたが、${p.name} を人狼として指名し、逆転に成功しました。`
        );
      } else {
        logFail(
          `人狼指名失敗… 実際の人狼は ${realWolf.name} でした。人狼陣営の勝利です。`
        );
        showResult(
          "人狼陣営の勝利",
          `指名された ${p.name} は人狼ではありませんでした。真の人狼は ${realWolf.name} でした。`
        );
      }
      GameState.resultLocked = true;
    });
    btnWrap.appendChild(b);
  });

  extraEl.appendChild(btnWrap);

  const titleEl = $("#result-title");
  const sumEl = $("#result-summary");
  if (titleEl) titleEl.textContent = "最終判定: 人狼指名フェーズ";
  if (sumEl)
    sumEl.textContent =
      "黒星が過半数ですが、ドクターは一度も失敗していません。プレイヤーからの話し合いをもとに、人狼を1名指名してください。";

  openModal("result-modal");
}

