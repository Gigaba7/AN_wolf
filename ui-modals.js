// モーダルと画面遷移管理

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

  // 背景の不透明化：ゲーム画面以外は不透明、ゲーム画面は透明
  if (typeof document !== "undefined" && document.body) {
    const shouldOpaque = toId !== "main-screen";
    document.body.classList.toggle("opaque-bg", shouldOpaque);
  }
}

export { openModal, closeModal, closeAllRouletteModals, switchScreen };
