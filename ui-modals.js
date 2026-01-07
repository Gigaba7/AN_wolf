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
}

export { openModal, closeModal, closeAllRouletteModals, switchScreen };
