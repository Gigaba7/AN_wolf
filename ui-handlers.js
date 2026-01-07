// UIイベントハンドラー

import { GameState, $ } from "./game-state.js";
import { openModal, switchScreen, closeModal } from "./ui-modals.js";
import { logSystem, logTurn } from "./game-logging.js";
import { createRoomAndStartGame, joinRoomAndSync, stopRoomSync, startGameAsHost, acknowledgeRoleReveal } from "./firebase-sync.js";
import { signInAnonymously, getCurrentUser } from "./firebase-auth.js";
import { assignRoles, saveRolesToFirebase, updateGameStateFromWaiting } from "./game-roles.js";
import { renderAll, renderWaitingScreen } from "./ui-render.module.js";
import { onSuccess, onFail, onDoctorPunch, onWolfAction } from "./game-logic.js";
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

      // 初回スナップショット前でもホストが参加者として見えるようにローカル反映
      if (currentUser?.uid) {
        GameState.players = [
          {
            id: currentUser.uid,
            name: hostName,
            avatarLetter: hostName[0] || "?",
            avatarImage: null,
            role: /** @type {any} */ (null),
          },
        ];
      }
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

      // 初回スナップショット前でも自分が参加者として見えるようにローカル反映
      const currentUser = getCurrentUser();
      if (currentUser?.uid) {
        GameState.players = [
          {
            id: currentUser.uid,
            name: playerName,
            avatarLetter: playerName[0] || "?",
            avatarImage: null,
            role: /** @type {any} */ (null),
          },
        ];
      }
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
  
  const setCopiedFeedback = (btn) => {
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = "コピーしました";
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = prev;
      btn.disabled = false;
    }, 900);
  };

  $("#btn-copy-room-id")?.addEventListener("click", () => {
    const roomIdDisplay = $("#room-id-display");
    if (roomIdDisplay && roomIdDisplay.textContent) {
      const roomId = roomIdDisplay.textContent;
      navigator.clipboard.writeText(roomId).then(() => {
        setCopiedFeedback($("#btn-copy-room-id"));
      }).catch(() => {
        // フォールバック
        const textarea = document.createElement("textarea");
        textarea.value = roomId;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        setCopiedFeedback($("#btn-copy-room-id"));
      });
    }
  });
  
  // 待機画面のボタン
  $("#btn-copy-waiting-room-id")?.addEventListener("click", () => {
    const roomIdEl = $("#waiting-room-id");
    const actualRoomId = roomIdEl?.dataset?.roomId || (typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null);
    if (actualRoomId) {
      navigator.clipboard.writeText(actualRoomId).then(() => {
        setCopiedFeedback($("#btn-copy-waiting-room-id"));
      }).catch(() => {
        // フォールバック
        const textarea = document.createElement("textarea");
        textarea.value = actualRoomId;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        setCopiedFeedback($("#btn-copy-waiting-room-id"));
      });
    }
  });
  
  $("#btn-start-game-from-waiting")?.addEventListener("click", async () => {
    const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    if (!roomId) return;

    const createdBy = typeof window !== 'undefined' && window.RoomInfo?.config?.createdBy ? window.RoomInfo.config.createdBy : null;
    const myId = typeof window !== 'undefined' ? window.__uid : null;
    if (!createdBy || createdBy !== myId) {
      alert("ゲーム開始はホストのみが実行できます。");
      return;
    }

    try {
      await startGameAsHost(roomId);
      logSystem("ホストがゲーム開始（役職配布）を実行しました。");
    } catch (e) {
      alert(e?.message || "ゲーム開始に失敗しました。");
    }
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

  // 自分の役職確認OK
  $("#self-role-ok")?.addEventListener("click", async () => {
    const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    if (!roomId) return;
    try {
      await acknowledgeRoleReveal(roomId);
      closeModal("self-role-modal");
    } catch (e) {
      console.error("Failed to acknowledge role:", e);
    }
  });
}

export { setupHomeScreen, setupMainScreen, setupModals };
