// UIイベントハンドラー

import { GameState, $ } from "./game-state.js";
import { openModal, switchScreen, closeModal } from "./ui-modals.js";
import { logSystem, logTurn } from "./game-logging.js";
import { createRoomAndStartGame, joinRoomAndSync, stopRoomSync } from "./firebase-sync.js";
import { signInAnonymously, getCurrentUser } from "./firebase-auth.js";
import { assignRoles, saveRolesToFirebase, updateGameStateFromWaiting } from "./game-roles.js";
import { renderAll, renderWaitingScreen } from "./ui-render.js";
import { onNextPlayer, onSuccess, onFail, onDoctorPunch, onWolfAction } from "./game-logic.js";
import { startStageRoulette, startWolfRoulette } from "./game-roulette.js";

function setupHomeScreen() {
  const optBtn = $("#open-options");
  const tosBtn = $("#open-tos");

  optBtn?.addEventListener("click", () => openModal("options-modal"));
  tosBtn?.addEventListener("click", () => openModal("tos-modal"));
  
  // ルーム作成/参加ボタン
  $("#btn-create-room")?.addEventListener("click", () => {
    console.log('ルーム作成ボタンがクリックされました');
    $("#join-room-form")?.style.setProperty("display", "none");
    $("#room-info")?.style.setProperty("display", "none");
    const createRoomForm = $("#create-room-form");
    if (createRoomForm) {
      createRoomForm.style.setProperty("display", "block");
      console.log('作成フォームを表示しました');
    } else {
      console.error('作成フォーム要素が見つかりません');
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
      
      console.log('Room ID displayed:', roomId);
      
      // 待機画面に切り替え
      switchScreen("home-screen", "waiting-screen");
      renderWaitingScreen(roomId);
    } catch (error) {
      console.error('Failed to create room:', error);
      const errorMessage = error.message || '不明なエラーが発生しました';
      alert('ルーム作成に失敗しました:\n\n' + errorMessage + '\n\n詳細はブラウザのコンソール（F12）を確認してください。');
    }
  });
  
  $("#btn-join-room")?.addEventListener("click", () => {
    $("#join-room-form")?.style.setProperty("display", "block");
    $("#room-info")?.style.setProperty("display", "none");
    $("#create-room-form")?.style.setProperty("display", "none");
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
      // 参加後は待機画面に切り替え
      switchScreen("home-screen", "waiting-screen");
      renderWaitingScreen(roomId);
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
  
  // 待機画面のボタン
  $("#btn-copy-waiting-room-id")?.addEventListener("click", () => {
    const roomIdEl = $("#waiting-room-id");
    if (roomIdEl && roomIdEl.textContent) {
      const roomId = roomIdEl.textContent;
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
  
  $("#btn-start-game-from-waiting")?.addEventListener("click", async () => {
    const GameState = typeof window !== 'undefined' ? window.GameState : null;
    if (!GameState || !GameState.players) {
      alert("プレイヤー情報が取得できません。");
      return;
    }
    
    if (GameState.players.length < 3 || GameState.players.length > 8) {
      alert("プレイヤー人数は3〜8人にしてください。");
      return;
    }
    
    // 役職を割り当て
    assignRoles(GameState.players);
    
    // 役職をFirebaseに保存
    const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    if (roomId) {
      try {
        await saveRolesToFirebase(roomId, GameState.players);
      } catch (error) {
        console.error('Failed to save roles:', error);
      }
    }
    
    // ゲーム状態をplayingに変更
    if (roomId) {
      try {
        await updateGameStateFromWaiting(roomId);
      } catch (error) {
        console.error('Failed to update game state:', error);
      }
    }
    
    // メイン画面に切り替え
    switchScreen("waiting-screen", "main-screen");
    renderAll();
    logSystem(`ゲーム開始。プレイヤー数: ${GameState.players.length}人`);
    logTurn(`ターン1開始`);
  });
  
  $("#btn-leave-room")?.addEventListener("click", () => {
    if (confirm("ルームを退出しますか？")) {
      // ルーム同期を停止
      stopRoomSync();
      // ホーム画面に戻る
      switchScreen("waiting-screen", "home-screen");
      // フォームをリセット
      $("#create-room-form")?.style.setProperty("display", "none");
      $("#join-room-form")?.style.setProperty("display", "none");
      $("#room-info")?.style.setProperty("display", "none");
    }
  });
}

function setupMainScreen() {
  $("#btn-next-player")?.addEventListener("click", onNextPlayer);
  $("#btn-success")?.addEventListener("click", onSuccess);
  $("#btn-fail")?.addEventListener("click", onFail);
  $("#btn-doctor-punch")?.addEventListener("click", onDoctorPunch);
  $("#btn-wolf-action")?.addEventListener("click", onWolfAction);
  $("#main-options-btn")?.addEventListener("click", () => openModal("options-modal"));
}

function setupModals() {
  // モーダル閉じるボタン
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  $$("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modalId = btn.getAttribute("data-close-modal");
      if (modalId) {
        closeModal(modalId);
      }
    });
  });

  // ステージルーレット
  $("#stage-roulette-start")?.addEventListener("click", () => {
    startStageRoulette();
  });

  // 人狼妨害ルーレット
  $("#wolf-roulette-start")?.addEventListener("click", () => {
    startWolfRoulette();
  });

  // オプション
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

export { setupHomeScreen, setupMainScreen, setupModals };
