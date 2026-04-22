/**
 * Setup popup for adding a Google account.
 *
 * M1: no OAuth. Collects a display name, creates a stub account record via an
 * internal runtime message to the background, then posts back to the
 * setup-token pending promise so the host's openSetupPopup RPC resolves.
 */

const params = new URLSearchParams(location.search);
const setupToken = params.get("setupToken");

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const msg = browser.i18n.getMessage(el.dataset.i18n);
    if (msg) el.textContent = msg;
  });
  document.title = browser.i18n.getMessage("setup.title") ?? "Add a Google account";
}

function showError(message) {
  const el = document.getElementById("error");
  el.textContent = message;
  el.classList.add("visible");
}

async function onFinish() {
  const accountName = document.getElementById("account-name").value.trim();
  if (!accountName) {
    showError("Please enter an account label.");
    return;
  }
  if (!setupToken) {
    showError("Missing setup token. Open this window through TbSync.");
    return;
  }

  const finishBtn = document.getElementById("btn-finish");
  finishBtn.disabled = true;

  try {
    const { providerAccountId, initialFolders } = await browser.runtime.sendMessage({
      type: "google.createStubAccount",
      accountName,
    });

    await browser.runtime.sendMessage({
      type: "tbsync-setup-completed",
      setupToken,
      providerAccountId,
      accountName,
      initialFolders,
    });

    window.close();
  } catch (err) {
    finishBtn.disabled = false;
    showError(err.message ?? String(err));
  }
}

applyI18n();
document.getElementById("btn-cancel").addEventListener("click", () => window.close());
document.getElementById("btn-finish").addEventListener("click", onFinish);
