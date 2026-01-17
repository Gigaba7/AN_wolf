// UI描画管理（通常script互換版）
// 何らかの理由でこのファイルが <script src="./ui-render.js"></script> のように
// moduleではない形で読み込まれても落ちないようにするためのフォールバックです。
// 実際のアプリでは ui-render.module.js を import して使用します。

(function () {
  const $ = (sel) => document.querySelector(sel);

  function getGameState() {
    return typeof window !== "undefined" ? window.GameState : null;
  }

  function renderWaitingScreen(roomId) {
    const GameState = getGameState();
    const roomIdEl = $("#waiting-room-id");
    const playersListEl = $("#waiting-players-list");
    const playersCountEl = $("#waiting-players-count");
    const startBtn = $("#btn-start-game-from-waiting");

    if (roomIdEl && roomId) {
      roomIdEl.textContent = "••••••";
      roomIdEl.dataset.roomId = roomId;
    }

    if (!playersListEl || !GameState) return;

    playersListEl.innerHTML = "";
    const players = Array.isArray(GameState.players) ? GameState.players : [];

    if (!players.length) {
      const empty = document.createElement("div");
      empty.style.gridColumn = "1 / -1";
      empty.style.textAlign = "center";
      empty.style.color = "#a0a4ba";
      empty.style.padding = "12px 0";
      empty.textContent = "参加者を同期中…";
      playersListEl.appendChild(empty);
    } else {
      players.forEach((player) => {
        const playerItem = document.createElement("div");
        playerItem.className = "waiting-player-item";

        const av = document.createElement("div");
        av.className = "waiting-player-avatar";
        if (player.avatarImage) {
          const img = document.createElement("img");
          img.src = player.avatarImage;
          img.alt = "";
          av.appendChild(img);
        } else {
          av.textContent = player.avatarLetter || "?";
        }

        const nm = document.createElement("div");
        nm.className = "waiting-player-name";
        nm.textContent = player.name || "プレイヤー";

        playerItem.appendChild(av);
        playerItem.appendChild(nm);
        playersListEl.appendChild(playerItem);
      });
    }

    if (playersCountEl) {
      playersCountEl.textContent = String(players.length || 0);
    }

    if (startBtn) {
      const canStart = players.length >= 3 && players.length <= 7;
      startBtn.disabled = !canStart;
      startBtn.textContent = canStart
        ? `ゲーム開始 (${players.length}人)`
        : `ゲーム開始 (最低3人必要 / 現在${players.length}人)`;
    }
  }

  function renderAll() {
    const roomId =
      typeof window !== "undefined" && window.getCurrentRoomId
        ? window.getCurrentRoomId()
        : null;
    const waitingScreen = $("#waiting-screen");
    if (waitingScreen && waitingScreen.classList.contains("active") && roomId) {
      renderWaitingScreen(roomId);
    }
  }

  // firebase-sync.js から呼べるように公開
  if (typeof window !== "undefined") {
    window.renderAll = window.renderAll || renderAll;
    window.renderWaitingScreen = window.renderWaitingScreen || renderWaitingScreen;
  }
})();
