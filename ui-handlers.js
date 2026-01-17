// UIイベントハンドラー

import { GameState, $ } from "./game-state.js";
import { openModal, switchScreen, closeModal } from "./ui-modals.js";
import { createRoomAndStartGame, joinRoomAndSync, stopRoomSync, startGameAsHost, acknowledgeRoleReveal, syncToFirebase, endDiscussionPhase, extendDiscussionPhase, wolfDecision } from "./firebase-sync.js";
import { signInAnonymously, getCurrentUser } from "./firebase-auth.js";
import { assignRoles, saveRolesToFirebase, updateGameStateFromWaiting } from "./game-roles.js";
import { renderAll, renderWaitingScreen } from "./ui-render.module.js";
import { onSuccess, onFail, onDoctorPunch, onDoctorSkip } from "./game-logic.js";
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

  if (soundEl instanceof HTMLInputElement) {
    soundEl.checked = GameState.options.sound;
  }
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
        maxPlayers: 7,
        stageMinChapter: GameState.options.stageMinChapter,
        stageMaxChapter: GameState.options.stageMaxChapter,
        stageRangesByTurn: GameState.options.stageRangesByTurn,
        wolfActions: GameState.options.wolfActions,
        // 旧互換（将来削除可）
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

  // ルームID表示/非表示切り替え
  $("#toggle-room-id-visibility")?.addEventListener("click", () => {
    const input = $("#room-id-input");
    if (input instanceof HTMLInputElement) {
      if (input.type === "password") {
        input.type = "text";
      } else {
        input.type = "password";
      }
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

  // ルール設定ボタン（GMのみ表示）
  $("#btn-rules-settings")?.addEventListener("click", () => {
    refreshRulesSettingsModalControls();
    openModal("rules-settings-modal");
  });

  // 待機画面のルームID表示/非表示切り替え
  $("#toggle-waiting-room-id-visibility")?.addEventListener("click", () => {
    const roomIdEl = $("#waiting-room-id");
    if (roomIdEl) {
      const actualRoomId = roomIdEl.dataset?.roomId || (typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null);
      if (actualRoomId) {
        if (roomIdEl.textContent === "••••••") {
          roomIdEl.textContent = actualRoomId;
        } else {
          roomIdEl.textContent = "••••••";
        }
      }
    }
  });
}

function refreshRulesSettingsModalControls() {
  const stageRangesEl = $("#rules-stage-ranges");
  const wolfActionsEditorEl = $("#rules-wolf-actions-editor");
  const wolfCostEl = $("#rules-wolf-initial-cost");
  const ruleTextEl = $("#rules-rule-text");

  // ターンごとの章レンジを描画
  if (stageRangesEl instanceof HTMLElement) {
    const maxTurns = Number(GameState.maxTurns || 5) || 5;
    const ranges = Array.isArray(GameState.options.stageRangesByTurn) && GameState.options.stageRangesByTurn.length
      ? GameState.options.stageRangesByTurn
      : Array.from({ length: maxTurns }, () => ({ min: GameState.options.stageMinChapter, max: GameState.options.stageMaxChapter }));

    stageRangesEl.innerHTML = "";

    const clampChapter = (n) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return 0;
      return Math.max(0, Math.min(15, Math.floor(v)));
    };

    const makeChapterStepper = (value) => {
      const wrap = document.createElement("div");
      wrap.style.display = "flex";
      wrap.style.alignItems = "center";
      wrap.style.gap = "4px";
      wrap.style.flex = "0 0 auto";

      const btnStyle = (btn) => {
        btn.type = "button";
        btn.style.width = "28px";
        btn.style.height = "28px";
        btn.style.borderRadius = "8px";
        btn.style.border = "1px solid rgba(255,255,255,0.18)";
        btn.style.background = "rgba(255,255,255,0.04)";
        btn.style.color = "#f5f5f7";
        btn.style.cursor = "pointer";
        btn.style.lineHeight = "1";
      };

      const minus = document.createElement("button");
      minus.textContent = "−";
      btnStyle(minus);

      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.max = "15";
      input.step = "1";
      input.value = String(clampChapter(value));
      input.inputMode = "numeric";
      input.style.width = "56px";
      input.style.padding = "6px 8px";
      input.style.borderRadius = "8px";
      input.style.border = "1px solid rgba(255,255,255,0.18)";
      input.style.background = "rgba(5,7,18,0.65)";
      input.style.color = "#f5f5f7";
      input.style.textAlign = "center";
      input.style.fontSize = "13px";

      const suffix = document.createElement("span");
      suffix.textContent = "章";
      suffix.style.opacity = "0.75";
      suffix.style.fontSize = "12px";

      const plus = document.createElement("button");
      plus.textContent = "+";
      btnStyle(plus);

      const setValue = (next) => {
        input.value = String(clampChapter(next));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };

      minus.addEventListener("click", () => setValue(Number(input.value) - 1));
      plus.addEventListener("click", () => setValue(Number(input.value) + 1));
      input.addEventListener("blur", () => setValue(input.value));

      wrap.appendChild(minus);
      wrap.appendChild(input);
      wrap.appendChild(suffix);
      wrap.appendChild(plus);

      return { wrap, input };
    };

    for (let t = 1; t <= maxTurns; t++) {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "6px";

      const label = document.createElement("div");
      label.textContent = `${t}ラウンド目`;
      label.style.width = "80px";
      label.style.opacity = "0.9";
      label.style.fontSize = "13px";

      const min = Number(ranges[t - 1]?.min);
      const max = Number(ranges[t - 1]?.max);
      const minStep = makeChapterStepper(Number.isFinite(min) ? min : GameState.options.stageMinChapter);
      const maxStep = makeChapterStepper(Number.isFinite(max) ? max : GameState.options.stageMaxChapter);
      minStep.input.dataset.turn = String(t);
      maxStep.input.dataset.turn = String(t);
      minStep.input.dataset.kind = "min";
      maxStep.input.dataset.kind = "max";

      // min <= max を常に維持
      const normalize = (prefer) => {
        let a = clampChapter(minStep.input.value);
        let b = clampChapter(maxStep.input.value);
        if (a > b) {
          if (prefer === "min") b = a;
          else a = b;
        }
        minStep.input.value = String(a);
        maxStep.input.value = String(b);
      };
      minStep.input.addEventListener("change", () => normalize("min"));
      maxStep.input.addEventListener("change", () => normalize("max"));

      const sep = document.createElement("span");
      sep.textContent = "〜";
      sep.style.opacity = "0.7";
      sep.style.margin = "0 2px";

      row.appendChild(label);
      row.appendChild(minStep.wrap);
      row.appendChild(sep);
      row.appendChild(maxStep.wrap);
      stageRangesEl.appendChild(row);
    }
  }

  // 妨害エディタを描画（表示/編集: キー / 表示文言 / コスト / ON-OFF）
  if (wolfActionsEditorEl instanceof HTMLElement) {
    const actions = Array.isArray(GameState.options.wolfActions) && GameState.options.wolfActions.length
      ? GameState.options.wolfActions
      : [];

    wolfActionsEditorEl.innerHTML = "";

    actions.forEach((a) => {
      const key = a?.text || "";
      const wrap = document.createElement("div");
      wrap.style.padding = "10px";
      wrap.style.border = "1px solid rgba(255,255,255,0.12)";
      wrap.style.borderRadius = "10px";
      wrap.style.background = "rgba(255,255,255,0.03)";
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.gap = "8px";

      const top = document.createElement("div");
      top.style.display = "flex";
      top.style.justifyContent = "space-between";
      top.style.gap = "10px";
      top.style.alignItems = "center";

      const name = document.createElement("div");
      name.style.fontWeight = "600";
      name.textContent = a.displayName || a.text || "妨害";

      const hint = document.createElement("div");
      hint.style.fontSize = "11px";
      hint.style.opacity = "0.75";
      hint.textContent = `キー: ${key}`;

      top.appendChild(name);
      top.appendChild(hint);
      wrap.appendChild(top);

      const grid = document.createElement("div");
      grid.style.display = "grid";
      grid.style.gridTemplateColumns = "1fr 140px 120px";
      grid.style.gap = "8px";

      const displayInput = document.createElement("input");
      displayInput.type = "text";
      displayInput.placeholder = "表示文言（リスト表示）";
      displayInput.value = a.displayName || a.text || "";
      displayInput.dataset.actionKey = key;
      displayInput.dataset.field = "displayName";

      const costInput = document.createElement("input");
      costInput.type = "number";
      costInput.min = "0";
      costInput.max = "999";
      costInput.step = "1";
      costInput.value = String(Number.isFinite(Number(a.cost)) ? Number(a.cost) : 0);
      costInput.dataset.actionKey = key;
      costInput.dataset.field = "cost";

      // ON/OFF
      const enabledWrap = document.createElement("label");
      enabledWrap.style.display = "flex";
      enabledWrap.style.alignItems = "center";
      enabledWrap.style.gap = "8px";
      enabledWrap.style.padding = "8px 10px";
      enabledWrap.style.borderRadius = "10px";
      enabledWrap.style.border = "1px solid rgba(255,255,255,0.2)";
      enabledWrap.style.background = "rgba(5,7,18,0.65)";
      enabledWrap.style.color = "#f5f5f7";
      enabledWrap.style.fontSize = "13px";

      const enabledInput = document.createElement("input");
      enabledInput.type = "checkbox";
      enabledInput.checked = a?.enabled !== false; // デフォルトON
      enabledInput.dataset.actionKey = key;
      enabledInput.dataset.field = "enabled";

      const enabledText = document.createElement("span");
      enabledText.textContent = "ON";
      enabledText.style.opacity = "0.9";

      enabledWrap.appendChild(enabledInput);
      enabledWrap.appendChild(enabledText);

      [displayInput, costInput].forEach((el) => {
        el.style.width = "100%";
        el.style.padding = "8px";
        el.style.borderRadius = "8px";
        el.style.border = "1px solid rgba(255,255,255,0.2)";
        el.style.background = "rgba(5,7,18,0.8)";
        el.style.color = "#f5f5f7";
        el.style.fontSize = "13px";
      });

      // 背水の陣は特殊仕様：キー/表示文言を編集できない
      if (key === "背水の陣") {
        displayInput.disabled = true;
        displayInput.style.opacity = "0.7";
      }

      grid.appendChild(displayInput);
      grid.appendChild(enabledWrap);
      grid.appendChild(costInput);
      wrap.appendChild(grid);

      if (key === "背水の陣") {
        const note = document.createElement("div");
        note.textContent = "※背水の陣は特殊な仕様のため編集することができません";
        note.style.fontSize = "12px";
        note.style.color = "#a0a4ba";
        note.style.opacity = "0.95";
        wrap.appendChild(note);
      }

      // ルーレット妨害の場合：候補を編集できる（デフォルトはアコーディオンで非表示）
      if (a?.requiresRoulette === true) {
        const details = document.createElement("details");
        details.style.marginTop = "6px";
        details.style.border = "1px solid rgba(255,255,255,0.10)";
        details.style.borderRadius = "10px";
        details.style.background = "rgba(5,7,18,0.35)";

        const summary = document.createElement("summary");
        summary.textContent = "ルーレット候補（編集）";
        summary.style.cursor = "pointer";
        summary.style.padding = "10px 12px";
        summary.style.userSelect = "none";
        summary.style.fontSize = "12px";
        summary.style.color = "#d4d6e3";
        details.appendChild(summary);

        const body = document.createElement("div");
        body.style.padding = "10px 12px 12px";
        body.style.display = "flex";
        body.style.flexDirection = "column";
        body.style.gap = "6px";

        const help = document.createElement("div");
        help.textContent = "1行につき1候補（空行は無視されます）";
        help.style.fontSize = "11px";
        help.style.color = "#a0a4ba";
        body.appendChild(help);

        const ta = document.createElement("textarea");
        ta.rows = 6;
        ta.placeholder = "例）\n先鋒\n前衛\n重装\n狙撃\n術師\n医療\n補助\n特殊";
        ta.value = Array.isArray(a.rouletteOptions) ? a.rouletteOptions.join("\n") : "";
        ta.dataset.actionKey = key;
        ta.dataset.field = "rouletteOptions";
        ta.style.width = "100%";
        ta.style.borderRadius = "10px";
        ta.style.border = "1px solid rgba(255,255,255,0.2)";
        ta.style.background = "rgba(5,7,18,0.8)";
        ta.style.color = "#f5f5f7";
        ta.style.padding = "8px";
        ta.style.fontSize = "12px";
        ta.style.resize = "vertical";
        body.appendChild(ta);

        details.appendChild(body);
        wrap.appendChild(details);
      }

      wolfActionsEditorEl.appendChild(wrap);
    });
  }

  if (wolfCostEl instanceof HTMLInputElement) {
    // ルーム設定から初期コストを取得、なければデフォルト100
    const roomId = typeof window !== "undefined" && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    const roomInfo = typeof window !== "undefined" ? window.RoomInfo : null;
    const wolfInitialCost = roomInfo?.config?.wolfInitialCost || 100;
    wolfCostEl.value = String(wolfInitialCost);
  }

  // ルールテキスト
  if (ruleTextEl instanceof HTMLTextAreaElement) {
    // ルーム設定を優先（参加者側も同じ値を見る）
    const fromRoom = typeof window !== "undefined" ? window.RoomInfo?.config?.ruleText : null;
    const v = typeof fromRoom === "string" ? fromRoom : (GameState.options.ruleText || "");
    ruleTextEl.value = v;
  }
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
  // 参加者画面：役職ボタンは画面中央のポップアップとして表示
  // 画面中央のドクター神拳ポップアップのボタン
  $("#doctor-punch-modal-use")?.addEventListener("click", () => {
    const modal = document.getElementById("doctor-punch-modal");
    if (modal) {
      modal.classList.add("hidden");
    }
    onDoctorPunch();
  });
  
  $("#doctor-punch-modal-skip")?.addEventListener("click", () => {
    const modal = document.getElementById("doctor-punch-modal");
    if (modal) {
      modal.classList.add("hidden");
    }
    onDoctorSkip();
  });
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
  // モーダル外をクリックしても閉じないようにする（閉じるボタンのみで処理）
  // モーダル自体のクリックイベントを無効化（モーダルコンテンツ内のクリックは有効）
  const wolfActionModal = document.getElementById("wolf-action-select-modal");
  if (wolfActionModal) {
    wolfActionModal.addEventListener("click", (e) => {
      // モーダルコンテンツ外（バックドロップ）をクリックしても閉じない
      if (e.target === wolfActionModal || e.target.classList.contains("modal-backdrop")) {
        e.stopPropagation();
      }
    });
    
    // 「閉じる」ボタンの処理：妨害なしとして処理
    const closeBtn = wolfActionModal.querySelector('[data-close-modal="wolf-action-select-modal"]');
    if (closeBtn) {
      // 既存のイベントリスナーを削除（setupModalsで追加されたものと重複しないように）
      const newCloseBtn = closeBtn.cloneNode(true);
      closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
      
      newCloseBtn.addEventListener("click", async () => {
        const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
        if (!roomId) return;
        
        try {
          const { wolfDecision } = await import("./firebase-sync.js");
          await wolfDecision(roomId, "skip");
          closeModal("wolf-action-select-modal");
        } catch (error) {
          console.error('Failed to skip wolf action:', error);
          alert(error?.message || "妨害選択のキャンセルに失敗しました。");
        }
      });
    }
  }
  
  
  // GM：役職一覧OK（役職一覧 → マッチ開始待機）
  $("#gm-roles-ok")?.addEventListener("click", async () => {
    const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    if (!roomId) return;
    
    // ボタンが無効化されている場合は何もしない
    const btn = $("#gm-roles-ok");
    if (btn && btn.hasAttribute("disabled")) {
      return;
    }
    
    // まずGMの役職確認OKを送信
    try {
      await acknowledgeRoleReveal(roomId);
    } catch (e) {
      console.error("Failed to acknowledge role:", e);
      return;
    }
    
    // 役職一覧モーダルを閉じる
    closeModal("gm-roles-modal");
    
    // 全員OKならゲーム開始
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
  });

  // オプション
  const soundEl = $("#opt-sound");

  if (soundEl instanceof HTMLInputElement) {
    soundEl.checked = GameState.options.sound;
  }

  $("#opt-save")?.addEventListener("click", () => {
    if (soundEl instanceof HTMLInputElement) {
      GameState.options.sound = soundEl.checked;
    }

    closeModal("options-modal");
  });

  $("#opt-back-home")?.addEventListener("click", () => {
    closeModal("options-modal");
    switchScreen("main-screen", "home-screen");
  });

  $("#opt-open-tos")?.addEventListener("click", () => openModal("tos-modal"));
  $("#open-tos")?.addEventListener("click", () => openModal("tos-modal"));
  $("#result-reset")?.addEventListener("click", () => location.reload());

  // 自分の役職確認OK（GMは無効化されているので、ゲストのみ有効）
  $("#self-role-ok")?.addEventListener("click", async () => {
    const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    if (!roomId) return;
    
    // ボタンが無効化されている場合は何もしない
    const okBtn = $("#self-role-ok");
    if (okBtn && okBtn.hasAttribute("disabled")) {
      return;
    }
    
    try {
      await acknowledgeRoleReveal(roomId);
      // OK後はモーダルを閉じず、「開始待機中…」を表示する（全員OKで自動的に開始）
      const waitText = $("#self-role-waiting");
      okBtn?.setAttribute("disabled", "true");
      if (okBtn) okBtn.textContent = "OK済み";
      waitText?.classList.remove("hidden");
    } catch (e) {
      console.error("Failed to acknowledge role:", e);
    }
  });

  // ルール設定モーダルの保存ボタン
  $("#rules-save")?.addEventListener("click", () => {
    const stageRangesEl = $("#rules-stage-ranges");
    const wolfActionsEditorEl = $("#rules-wolf-actions-editor");
    const wolfCostEl = $("#rules-wolf-initial-cost");
    const ruleTextEl = $("#rules-rule-text");

    // ターンごとの章レンジを収集
    /** @type {{min:number,max:number}[]} */
    const stageRangesByTurn = [];
    if (stageRangesEl instanceof HTMLElement) {
      const inputs = Array.from(stageRangesEl.querySelectorAll("input[data-turn][data-kind]"));
      const maxTurns = Number(GameState.maxTurns || 5) || 5;
      for (let t = 1; t <= maxTurns; t++) {
        const minEl = inputs.find((s) => s.dataset?.turn === String(t) && s.dataset?.kind === "min");
        const maxEl = inputs.find((s) => s.dataset?.turn === String(t) && s.dataset?.kind === "max");
        const min = Number(minEl?.value);
        const max = Number(maxEl?.value);
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
          alert(`ステージ範囲（${t}ラウンド目）が不正です。`);
          return;
        }
        if (min > max) {
          alert(`ステージ範囲（${t}ラウンド目）の最小章は最大章より大きくできません。`);
          return;
        }
        stageRangesByTurn.push({ min, max });
      }
    }

    if (stageRangesByTurn.length) {
      GameState.options.stageRangesByTurn = stageRangesByTurn;
      // 互換のため、全体レンジは1ラウンド目の設定を保持
      GameState.options.stageMinChapter = stageRangesByTurn[0].min;
      GameState.options.stageMaxChapter = stageRangesByTurn[0].max;
    }

    // 妨害（title / displayName / cost）を収集
    if (wolfActionsEditorEl instanceof HTMLElement) {
      try {
        const inputs = Array.from(wolfActionsEditorEl.querySelectorAll("input"));
        const textareas = Array.from(wolfActionsEditorEl.querySelectorAll("textarea"));
        const current = Array.isArray(GameState.options.wolfActions) ? GameState.options.wolfActions : [];
        const next = current.map((a) => {
          const key = a?.text || "";
          const get = (field) =>
            inputs.find((el) => el.dataset?.actionKey === key && el.dataset?.field === field) ||
            textareas.find((el) => el.dataset?.actionKey === key && el.dataset?.field === field);

          const displayName = (get("displayName")?.value || "").trim();
          const costRaw = get("cost")?.value;
          const cost = Number(costRaw);
          if (!Number.isFinite(cost) || cost < 0 || cost > 999) {
            throw new Error(`妨害「${key}」のコストが不正です。`);
          }

          const enabledEl = get("enabled");
          const enabled =
            enabledEl instanceof HTMLInputElement && enabledEl.type === "checkbox"
              ? enabledEl.checked
              : (a?.enabled !== false);

          // ルーレット候補（requiresRoulette の場合のみ）
          let rouletteOptions = Array.isArray(a.rouletteOptions) ? a.rouletteOptions : null;
          if (a?.requiresRoulette === true) {
            const raw = (get("rouletteOptions")?.value || "").trim();
            const lines = raw
              .split("\n")
              .map((v) => v.trim())
              .filter(Boolean);
            // 空なら「誤って消す」を避けるため既存を維持
            if (lines.length) {
              rouletteOptions = lines;
            }
          }

          return {
            ...a,
            enabled: enabled,
            // 背水の陣はキー/表示文言を編集不可（特殊仕様）
            displayName: key === "背水の陣" ? (a.displayName || a.text) : (displayName || a.displayName || a.text),
            cost: Math.floor(cost),
            ...(rouletteOptions ? { rouletteOptions } : {}),
          };
        });

        GameState.options.wolfActions = next;
      } catch (e) {
        alert(e?.message || "妨害設定の保存に失敗しました。");
        return;
      }
    }
    
    let wolfInitialCost = 100; // デフォルト値
    if (wolfCostEl instanceof HTMLInputElement) {
      const cost = Number(wolfCostEl.value);
      if (Number.isFinite(cost) && cost >= 1 && cost <= 200) {
        wolfInitialCost = cost;
      } else {
        alert("人狼の初期コストは1〜200の範囲で設定してください。");
        return;
      }
    }

    // ルールテキストを保存（空でもOK）
    let ruleText = "";
    if (ruleTextEl instanceof HTMLTextAreaElement) {
      ruleText = (ruleTextEl.value || "").trim();
      GameState.options.ruleText = ruleText;
    }

    // ルームに同期（ホストのみ）
    const roomId = typeof window !== "undefined" && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
    const myId = typeof window !== "undefined" ? window.__uid : null;
    const isHost = !!(roomId && createdBy && myId && createdBy === myId);
    if (roomId && isHost) {
      syncToFirebase("updateConfig", {
        stageMinChapter: GameState.options.stageMinChapter, // 互換
        stageMaxChapter: GameState.options.stageMaxChapter, // 互換
        stageRangesByTurn: GameState.options.stageRangesByTurn,
        wolfActions: GameState.options.wolfActions,
        wolfInitialCost: wolfInitialCost,
        ruleText: ruleText,
        roomId,
      }).catch((e) => {
        console.error("Failed to update config:", e);
        alert(`ルール設定の同期に失敗しました: ${e.message}`);
      });
    }

    closeModal("rules-settings-modal");
  });

  // 会議フェーズ：終了ボタン
  $("#discussion-end")?.addEventListener("click", async () => {
    const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
    const myId = typeof window !== "undefined" ? window.__uid : null;
    const isGM = !!(createdBy && myId && createdBy === myId);
    if (!isGM) {
      alert("会議フェーズの終了はGMのみが実行できます。");
      return;
    }

    const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    if (!roomId) {
      alert("ルームIDが取得できませんでした。");
      return;
    }

    try {
      await endDiscussionPhase(roomId);
    } catch (e) {
      console.error("Failed to end discussion phase:", e);
      alert(`会議フェーズの終了に失敗しました: ${e.message}`);
    }
  });

  // 会議フェーズ：2分延長ボタン
  $("#discussion-extend")?.addEventListener("click", async () => {
    const createdBy = typeof window !== "undefined" ? window.RoomInfo?.config?.createdBy : null;
    const myId = typeof window !== "undefined" ? window.__uid : null;
    const isGM = !!(createdBy && myId && createdBy === myId);
    if (!isGM) {
      alert("会議フェーズの延長はGMのみが実行できます。");
      return;
    }

    const roomId = typeof window !== 'undefined' && window.getCurrentRoomId ? window.getCurrentRoomId() : null;
    if (!roomId) {
      alert("ルームIDが取得できませんでした。");
      return;
    }

    try {
      await extendDiscussionPhase(roomId);
    } catch (e) {
      console.error("Failed to extend discussion phase:", e);
      alert(`会議フェーズの延長に失敗しました: ${e.message}`);
    }
  });

  // ルールブックを開く（ホーム画面）
  $("#open-rulebook")?.addEventListener("click", () => {
    openRulebook();
  });

  // ルールブックを開く（マッチング画面）
  $("#open-rulebook-from-waiting")?.addEventListener("click", () => {
    openRulebook();
  });

  // ルールブックを開く（オプション画面）
  $("#open-rulebook-from-options")?.addEventListener("click", () => {
    openRulebook();
  });

  // ルールブックを開く（ゲストUI）
  $("#open-rulebook-from-participant")?.addEventListener("click", () => {
    openRulebook();
  });

  // ルールブックのページ切り替え
  let currentRulebookPage = 1;
  const totalRulebookPages = 9;

  function updateRulebookPage() {
    // すべてのページを非表示
    for (let i = 1; i <= totalRulebookPages; i++) {
      const pageEl = document.getElementById(`rulebook-page-${i}`);
      if (pageEl) {
        pageEl.style.display = "none";
      }
    }

    // 現在のページを表示
    const currentPageEl = document.getElementById(`rulebook-page-${currentRulebookPage}`);
    if (currentPageEl) {
      currentPageEl.style.display = "block";
    }

    // ページインジケーターを更新
    const indicatorEl = document.getElementById("rulebook-page-indicator");
    if (indicatorEl) {
      indicatorEl.textContent = `${currentRulebookPage} / ${totalRulebookPages}`;
    }

    // 前へ/次へボタンの有効/無効を更新
    const prevBtn = document.getElementById("rulebook-prev");
    const nextBtn = document.getElementById("rulebook-next");
    if (prevBtn) {
      prevBtn.disabled = currentRulebookPage === 1;
    }
    if (nextBtn) {
      nextBtn.disabled = currentRulebookPage === totalRulebookPages;
    }
  }

  function openRulebook() {
    currentRulebookPage = 1;
    updateRulebookPage();
    // ルールブック内の「妨害一覧」をルーム設定（wolfActions）から再描画
    import("./ui-render.module.js")
      .then((m) => {
        if (m?.renderRulebookWolfActions) m.renderRulebookWolfActions();
      })
      .catch(() => {});
    openModal("rulebook-modal");
  }

  $("#rulebook-prev")?.addEventListener("click", () => {
    if (currentRulebookPage > 1) {
      currentRulebookPage--;
      updateRulebookPage();
    }
  });

  $("#rulebook-next")?.addEventListener("click", () => {
    if (currentRulebookPage < totalRulebookPages) {
      currentRulebookPage++;
      updateRulebookPage();
    }
  });
}

export { setupHomeScreen, setupMainScreen, setupParticipantScreen, setupModals };
