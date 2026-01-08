// UIイベントハンドラー

import { GameState, $ } from "./game-state.js";
import { openModal, switchScreen, closeModal } from "./ui-modals.js";
import { logSystem, logTurn } from "./game-logging.js";
import { createRoomAndStartGame, joinRoomAndSync, stopRoomSync, startGameAsHost, acknowledgeRoleReveal, syncToFirebase } from "./firebase-sync.js";
import { signInAnonymously, getCurrentUser } from "./firebase-auth.js";
import { assignRoles, saveRolesToFirebase, updateGameStateFromWaiting } from "./game-roles.js";
import { renderAll, renderWaitingScreen } from "./ui-render.module.js";
import { onSuccess, onFail, onDoctorPunch, onWolfAction } from "./game-logic.js";
import { startWolfRoulette } from "./game-roulette.js";
import { resolveWolfAction } from "./firebase-sync.js";

async function fileToResizedAvatarDataUrl(file) {
  if (!file) return null;
  if (!(file instanceof File)) return null;
  if (!file.type || !file.type.startsWith("image/")) {
    throw new Error("画像ファイルを選択してください。");
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    const loaded = new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
    });
    img.src = url;
    await loaded;

    const max = 128;
    const scale = Math.min(1, max / Math.max(img.width || 1, img.height || 1));
    const w = Math.max(1, Math.round((img.width || 1) * scale));
    const h = Math.max(1, Math.round((img.height || 1) * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);

    let dataUrl = "";
    try {
      dataUrl = canvas.toDataURL("image/webp", 0.85);
    } catch {}
    if (!dataUrl || !dataUrl.startsWith("data:image/webp")) {
      try {
        dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      } catch {}
    }
    return dataUrl || null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function setAvatarPreview(previewImg, letterEl, dataUrl, fallbackLetter) {
  if (letterEl) letterEl.textContent = fallbackLetter || "?";
  if (!(previewImg instanceof HTMLImageElement)) return;
  if (dataUrl) {
    previewImg.src = dataUrl;
    previewImg.classList.remove("hidden");
    if (letterEl) letterEl.classList.add("hidden");
  } else {
    previewImg.removeAttribute("src");
    previewImg.classList.add("hidden");
    if (letterEl) letterEl.classList.remove("hidden");
  }
}

function refreshOptionsModalControls() {
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

  // 共有項目（ステージ範囲/妨害内容）はホストのみ編集可
  const roomId = typeof window !== "undefined" && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
  const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
  const myId = typeof window !== "undefined" ? window.__uid : null;
  const isHost = !!(roomId && createdBy && myId && createdBy === myId);
  const inRoom = !!roomId;

  if (minEl instanceof HTMLSelectElement) minEl.disabled = inRoom && !isHost;
  if (maxEl instanceof HTMLSelectElement) maxEl.disabled = inRoom && !isHost;
  if (wolfEl instanceof HTMLTextAreaElement) wolfEl.disabled = inRoom && !isHost;
}

function setupHomeScreen() {
  const optBtn = $("#open-options");
  const tosBtn = $("#open-tos");

  // アバター（ホーム画面で選択 → ルーム作成/参加時にFirestoreへ保存）
  let pendingHostAvatarImage = null;
  let pendingPlayerAvatarImage = null;
  const hostPreview = $("#host-avatar-preview");
  const hostLetter = $("#host-avatar-letter");
  const hostFile = $("#host-avatar-file");
  const playerPreview = $("#player-avatar-preview");
  const playerLetter = $("#player-avatar-letter");
  const playerFile = $("#player-avatar-file");
  const hostNameInputEl = $("#host-name-input");
  const playerNameInputEl = $("#player-name-input");

  const updateLetterFromName = (name, letterEl) => {
    if (!letterEl) return;
    const t = (name || "").trim();
    letterEl.textContent = t ? t[0] : "?";
  };

  hostNameInputEl?.addEventListener("input", (e) => {
    const v = e?.target?.value || "";
    updateLetterFromName(v, hostLetter);
  });
  playerNameInputEl?.addEventListener("input", (e) => {
    const v = e?.target?.value || "";
    updateLetterFromName(v, playerLetter);
  });

  if (hostFile instanceof HTMLInputElement) {
    hostFile.addEventListener("change", async () => {
      try {
        const file = hostFile.files?.[0] || null;
        pendingHostAvatarImage = await fileToResizedAvatarDataUrl(file);
        const name = hostNameInputEl?.value || "";
        setAvatarPreview(hostPreview, hostLetter, pendingHostAvatarImage, (name || "").trim()[0] || "?");
      } catch (e) {
        console.error(e);
        alert(e?.message || "アイコン画像の読み込みに失敗しました。");
      }
    });
  }

  if (playerFile instanceof HTMLInputElement) {
    playerFile.addEventListener("change", async () => {
      try {
        const file = playerFile.files?.[0] || null;
        pendingPlayerAvatarImage = await fileToResizedAvatarDataUrl(file);
        const name = playerNameInputEl?.value || "";
        setAvatarPreview(playerPreview, playerLetter, pendingPlayerAvatarImage, (name || "").trim()[0] || "?");
      } catch (e) {
        console.error(e);
        alert(e?.message || "アイコン画像の読み込みに失敗しました。");
      }
    });
  }

  optBtn?.addEventListener("click", () => {
    refreshOptionsModalControls();
    openModal("options-modal");
  });
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
        hostAvatarLetter: hostName[0] || "?",
        hostAvatarImage: pendingHostAvatarImage,
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
            avatarImage: pendingHostAvatarImage,
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
      await joinRoomAndSync(roomId, playerName, pendingPlayerAvatarImage, playerName[0] || "?");
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
            avatarImage: pendingPlayerAvatarImage,
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
  // GM画面：成功/失敗ボタンのみ
  $("#btn-success")?.addEventListener("click", onSuccess);
  $("#btn-fail")?.addEventListener("click", onFail);
  $("#main-options-btn")?.addEventListener("click", () => {
    refreshOptionsModalControls();
    openModal("options-modal");
  });
  
  // ステージ選出は自動実行のため、ボタンは不要（削除）
}

function setupParticipantScreen() {
  // 参加者画面：役職ボタンのみ（妨害・神拳）
  $("#btn-wolf-action")?.addEventListener("click", onWolfAction);
  $("#btn-doctor-punch")?.addEventListener("click", onDoctorPunch);
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

  // GM画面：ステージ選出開始ボタン
  $("#btn-open-stage-roulette")?.addEventListener("click", () => {
    const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
    const myId = typeof window !== "undefined" ? window.__uid : null;
    const isGM = !!(createdBy && myId && createdBy === myId);
    if (!isGM) return;
    
    // ステージルーレットモーダルを開く
    const modal = document.getElementById("stage-roulette-modal");
    if (modal) {
      modal.classList.remove("hidden");
      // ルーレットを開始
      import("./game-roulette.js").then((module) => {
        if (module.startStageRoulette) {
          module.startStageRoulette();
        }
      }).catch((error) => {
        console.error("Failed to import game-roulette:", error);
      });
    }
  });

  // GM：妨害発動通知のOKボタン
  $("#gm-wolf-action-ok")?.addEventListener("click", async () => {
    const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    if (!roomId) return;
    
    try {
      // 通知をクリア
      const { syncToFirebase } = await import("./firebase-sync.js");
      await syncToFirebase("clearWolfActionNotification", { roomId });
      closeModal("gm-wolf-action-notification-modal");
    } catch (e) {
      console.error("Failed to clear notification:", e);
      closeModal("gm-wolf-action-notification-modal");
    }
  });

  // GM：職業ルーレット開始
  $("#job-roulette-start")?.addEventListener("click", () => {
    const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
    const myId = typeof window !== "undefined" ? window.__uid : null;
    const isGM = !!(createdBy && myId && createdBy === myId);
    if (!isGM) return;
    
    const itemsEl = document.getElementById("job-roulette-items");
    if (!itemsEl) return;
    
    const items = Array.from(itemsEl.querySelectorAll(".roulette-item"));
    if (items.length === 0) return;
    
    // ルーレットアニメーション
    let currentIndex = 0;
    const interval = setInterval(() => {
      items.forEach((el, idx) => {
        el.classList.toggle("active", idx === currentIndex);
      });
      currentIndex = (currentIndex + 1) % items.length;
    }, 100);
    
    setTimeout(() => {
      clearInterval(interval);
      const selected = items[Math.floor(Math.random() * items.length)];
      items.forEach((el) => {
        el.classList.remove("active");
        if (el === selected) {
          el.classList.add("selected");
        }
      });
      
      setTimeout(async () => {
        const selectedText = selected.textContent;
        const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
        if (roomId) {
          try {
            const { resolveWolfActionRoulette } = await import("./firebase-sync.js");
            await resolveWolfActionRoulette(roomId, selectedText);
            closeModal("job-roulette-modal");
          } catch (e) {
            console.error("Failed to resolve job roulette:", e);
            alert(e?.message || "職業ルーレットの確定に失敗しました。");
          }
        }
      }, 1000);
    }, 2000);
  });
  
  // 参加者：人狼妨害のスキップ（妨害選択UIから閉じる場合）
  // 注: 妨害選択UIから直接発動するため、スキップ処理は不要（モーダルを閉じるだけでOK）
  // ただし、妨害選択UIを閉じた時にスキップする場合は、モーダルの閉じるボタンで処理
  $("#wolf-action-select-modal")?.addEventListener("click", (e) => {
    if (e.target.classList.contains("modal-backdrop") || e.target.getAttribute("data-close-modal") === "wolf-action-select-modal") {
      // モーダルを閉じる = スキップ
      const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
      if (roomId) {
        import("./firebase-sync.js").then(({ wolfDecision }) => {
          wolfDecision(roomId, "skip").catch(() => {
            // エラーは無視（既にフェーズが変わっている可能性があるため）
          });
        });
      }
    }
  });
  
  // GM：アナウンスOK（注意ポップアップ → 役職一覧）
  $("#gm-announcement-ok")?.addEventListener("click", async () => {
    const announcementModal = document.getElementById("gm-announcement-modal");
    if (announcementModal) {
      announcementModal.classList.add("hidden");
    }
    
    // 役職一覧を表示
    const roomData = typeof window !== "undefined" ? window.RoomInfo : null;
    if (roomData) {
      const { showGMRolesModal } = await import("./firebase-sync.js");
      showGMRolesModal(roomData);
    }
  });
  
  // GM：役職一覧OK（役職一覧 → マッチ開始待機）
  $("#gm-roles-ok")?.addEventListener("click", async () => {
    closeModal("gm-roles-modal");
    
    // 役職一覧を確認した後、全員OKならゲーム開始
    const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    if (roomId) {
      try {
        const { advanceToPlayingIfAllAckedDB } = await import("./firebase-sync.js");
        await advanceToPlayingIfAllAckedDB(roomId);
      } catch (error) {
        // トランザクション競合エラーは無視（他のクライアントが既に処理済みの可能性）
        if (error?.code === "failed-precondition" || error?.code === "aborted") {
          console.log("Transaction conflict in advanceToPlayingIfAllAcked (ignored):", error.message);
          return;
        }
        console.error("Failed to advance to playing:", error);
      }
    }
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

    // 共有項目だけルームに同期（ホストのみ）
    const roomId = typeof window !== "undefined" && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
    const myId = typeof window !== "undefined" ? window.__uid : null;
    const isHost = !!(roomId && createdBy && myId && createdBy === myId);
    if (roomId && isHost) {
      syncToFirebase("updateConfig", {
        stageMinChapter: GameState.options.stageMinChapter,
        stageMaxChapter: GameState.options.stageMaxChapter,
        wolfActionTexts: GameState.options.wolfActionTexts,
        roomId,
      }).catch((e) => {
        console.error("Failed to update config:", e);
        alert(`オプション同期に失敗しました: ${e.message}`);
      });
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
      // OK後はモーダルを閉じず、「開始待機中…」を表示する（全員OKで自動的に開始）
      const okBtn = $("#self-role-ok");
      const waitText = $("#self-role-waiting");
      okBtn?.setAttribute("disabled", "true");
      if (okBtn) okBtn.textContent = "OK済み";
      waitText?.classList.remove("hidden");
    } catch (e) {
      console.error("Failed to acknowledge role:", e);
    }
  });
}

export { setupHomeScreen, setupMainScreen, setupParticipantScreen, setupModals };
