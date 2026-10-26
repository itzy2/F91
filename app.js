"use strict";

/*
 * STOCK POINT
 * Supabase接続・株式売買・保有株・ランキング・管理者ポイント付与
 *
 * 注意:
 * - ブラウザに service_role キーを設定しないこと。
 * - 売買処理は Supabase RPC の trade_stock を使用。
 * - ポイント付与は Supabase RPC の admin_grant_points を使用。
 */

const SUPABASE_URL = "https://qwswjasrorhstzueixcr.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_WarHJF6XeJEaAqhmu9djFA_puVUA4Br";

const INITIAL_POINTS = 10000;
const REFRESH_INTERVAL = 30000;

let db = null;
let currentUser = null;
let currentProfile = null;

let stockList = [];
let holdingList = [];
let profileList = [];
let transactionList = [];

let refreshTimer = null;
let isLoading = false;
let isTrading = false;
let isGranting = false;

const $ = (id) => document.getElementById(id);

function formatPoints(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "—";
  }

  return Math.round(number).toLocaleString("ja-JP") + " pt";
}

function formatDate(value) {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return date.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };

    return map[character];
  });
}

function showMessage(id, message, type = "") {
  const element = $(id);

  if (!element) return;

  element.textContent = message;
  element.className = "message";

  if (type) {
    element.classList.add(type);
  }
}

function showGlobalMessage(message, type = "") {
  const element = $("global-message");

  if (!element) return;

  element.textContent = message;
  element.className = "panel";

  if (type) {
    element.classList.add(type);
  }

  element.classList.remove("hidden");
}

function clearGlobalMessage() {
  $("global-message")?.classList.add("hidden");
}

function friendlyError(error) {
  const message = String(error?.message || error || "");

  if (/Invalid login credentials/i.test(message)) {
    return "メールアドレスまたはパスワードが正しくありません。";
  }

  if (/Email not confirmed/i.test(message)) {
    return "メールアドレスの確認が必要です。確認メールをチェックしてください。";
  }

  if (/User already registered/i.test(message)) {
    return "このメールアドレスはすでに登録されています。ログインしてください。";
  }

  if (/duplicate key/i.test(message)) {
    return "同じ情報がすでに登録されています。";
  }

  if (/row-level security|permission denied|not allowed/i.test(message)) {
    return "データベースのアクセス権限が不足しています。SupabaseのRLS設定を確認してください。";
  }

  if (/admin_grant_points/i.test(message)) {
    return "ポイント付与関数を利用できません。Supabase側の関数設定を確認してください。";
  }

  if (/trade_stock/i.test(message)) {
    return "売買関数を利用できません。Supabase側のtrade_stock設定を確認してください。";
  }

  if (/Failed to fetch|NetworkError|fetch failed/i.test(message)) {
    return "通信に失敗しました。ネットワークとSupabaseのURLを確認してください。";
  }

  return message || "処理に失敗しました。時間をおいて再度お試しください。";
}

function setButtonBusy(id, busy, busyText = "処理中...") {
  const button = $(id);

  if (!button) return;

  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent =
      button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function findStock(stockId) {
  return stockList.find((stock) => stock.id === stockId);
}

function stockName(stockId) {
  return findStock(stockId)?.name || stockId || "不明な銘柄";
}

function isAdmin() {
  return currentProfile?.role === "admin";
}

/* ------------------------------
   初期化
------------------------------ */

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  if (!window.supabase?.createClient) {
    $("config-warning").textContent =
      "Supabaseライブラリを読み込めませんでした。ネットワークを確認してください。";
    return;
  }

  if (
    !SUPABASE_URL.startsWith("https://") ||
    !SUPABASE_PUBLISHABLE_KEY
  ) {
    $("config-warning").textContent =
      "Supabaseの接続設定を確認してください。";
    return;
  }

  db = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY
  );

  bindEvents();

  const {
    data: { session },
    error
  } = await db.auth.getSession();

  if (error) {
    showMessage("login-message", friendlyError(error), "error");
  }

  await handleSession(session);

  db.auth.onAuthStateChange((_event, session) => {
    // 認証イベント内で重い処理を直接実行せず、次の処理に回す
    setTimeout(() => {
      handleSession(session);
    }, 0);
  });
}

function bindEvents() {
  $("login-form").addEventListener("submit", handleLogin);

  $("signup-btn").addEventListener("click", handleSignup);

  $("logout-btn").addEventListener("click", handleLogout);

  $("refresh-btn").addEventListener("click", async () => {
    await loadDashboard(true);
  });

  $("trade-form").addEventListener("submit", handleTrade);

  $("trade-stock").addEventListener("change", updateEstimate);
  $("trade-side").addEventListener("change", updateEstimate);
  $("quantity").addEventListener("input", updateEstimate);

  $("grant-form").addEventListener("submit", handleGrantPoints);

  $("stocks-body").addEventListener("click", (event) => {
    const button = event.target.closest("[data-select-stock]");

    if (!button) return;

    $("trade-stock").value = button.dataset.selectStock;
    updateEstimate();

    $("trade-form").scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  });
}

/* ------------------------------
   認証
------------------------------ */

async function handleLogin(event) {
  event.preventDefault();

  if (!db) return;

  const email = $("email").value.trim();
  const password = $("password").value;

  setButtonBusy("login-btn", true, "ログイン中...");
  showMessage("login-message", "");

  try {
    const { error } = await db.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;

    showMessage("login-message", "ログインしました。", "success");
  } catch (error) {
    showMessage("login-message", friendlyError(error), "error");
  } finally {
    setButtonBusy("login-btn", false);
  }
}

async function handleSignup() {
  if (!db) return;

  const email = $("email").value.trim();
  const password = $("password").value;

  if (!email || !password) {
    showMessage(
      "login-message",
      "メールアドレスとパスワードを入力してください。",
      "error"
    );
    return;
  }

  if (password.length < 6) {
    showMessage(
      "login-message",
      "パスワードは6文字以上にしてください。",
      "error"
    );
    return;
  }

  setButtonBusy("signup-btn", true, "登録中...");
  showMessage("login-message", "");

  try {
    const { data, error } = await db.auth.signUp({
      email,
      password
    });

    if (error) throw error;

    if (data.session) {
      showMessage(
        "login-message",
        "登録が完了しました。",
        "success"
      );
    } else {
      showMessage(
        "login-message",
        "登録を受け付けました。メール確認が必要な場合は、確認メールを開いてください。",
        "success"
      );
    }
  } catch (error) {
    showMessage("login-message", friendlyError(error), "error");
  } finally {
    setButtonBusy("signup-btn", false);
  }
}

async function handleLogout() {
  if (!db) return;

  const { error } = await db.auth.signOut();

  if (error) {
    showGlobalMessage(friendlyError(error), "error");
  }
}

async function handleSession(session) {
  const nextUser = session?.user || null;
  const previousUserId = currentUser?.id || null;
  const nextUserId = nextUser?.id || null;

  currentUser = nextUser;

  if (!currentUser) {
    currentProfile = null;
    stockList = [];
    holdingList = [];
    profileList = [];
    transactionList = [];

    stopAutoRefresh();

    $("auth-panel").classList.remove("hidden");
    $("app-panel").classList.add("hidden");
    $("logout-btn").classList.add("hidden");
    $("refresh-btn").disabled = true;
    $("whoami").textContent = "ログインしていません";

    return;
  }

  $("auth-panel").classList.add("hidden");
  $("app-panel").classList.remove("hidden");
  $("logout-btn").classList.remove("hidden");
  $("refresh-btn").disabled = false;

  if (previousUserId !== nextUserId) {
    clearGlobalMessage();
  }

  await loadProfile();

  if (currentProfile) {
    $("whoami").textContent =
      currentProfile.display_name ||
      currentUser.email ||
      "ログイン中";

    $("admin-panel").classList.toggle("hidden", !isAdmin());

    await loadDashboard(true);
    startAutoRefresh();
  } else {
    showGlobalMessage(
      "プロフィールを取得できません。Supabaseのprofilesテーブルと新規登録時のプロフィール作成設定を確認してください。",
      "error"
    );
  }
}

/* ------------------------------
   データ取得
------------------------------ */

async function loadProfile() {
  if (!currentUser) return;

  const { data, error } = await db
    .from("profiles")
    .select("id, display_name, role, points")
    .eq("id", currentUser.id)
    .maybeSingle();

  if (error) {
    currentProfile = null;
    showGlobalMessage(
      "プロフィール取得エラー: " + friendlyError(error),
      "error"
    );
    return;
  }

  currentProfile = data;
}

async function loadStocks() {
  const { data, error } = await db
    .from("stocks")
    .select("id, name, price, previous_price, updated_at")
    .order("id", { ascending: true });

  if (error) throw error;

  stockList = data || [];
}

async function loadHoldings() {
  const { data, error } = await db
    .from("holdings")
    .select("user_id, stock_id, quantity")
    .eq("user_id", currentUser.id);

  if (error) throw error;

  holdingList = data || [];
}

async function loadProfiles() {
  const { data, error } = await db
    .from("profiles")
    .select("id, display_name, role, points");

  if (error) throw error;

  profileList = data || [];
}

async function loadTransactions() {
  let query = db
    .from("transactions")
    .select("id, user_id, stock_id, side, quantity, price, total, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  // 一般ユーザーは自分の取引だけを取得
  if (!isAdmin()) {
    query = query.eq("user_id", currentUser.id);
  }

  const { data, error } = await query;

  if (error) throw error;

  transactionList = data || [];
}

async function loadDashboard(showStatus = false) {
  if (!currentUser || !currentProfile || isLoading) return;

  isLoading = true;
  $("refresh-btn").disabled = true;

  try {
    await loadStocks();

    // ユーザーごとのデータを読み込む
    await Promise.all([
      loadHoldings(),
      loadProfiles(),
      loadTransactions()
    ]);

    renderStocks();
    renderTradeOptions();
    renderHoldings();
    renderTransactions();
    renderRanking();
    renderSummary();
    updateEstimate();

    $("last-updated").textContent =
      "画面更新時刻: " + formatDate(new Date().toISOString());

    if (stockList.length !== 20) {
      showGlobalMessage(
        `現在の登録銘柄は${stockList.length}件です。20銘柄にするには、Supabaseのstocksテーブルに20件登録されていることを確認してください。`,
        "error"
      );
    } else {
      clearGlobalMessage();
    }

    if (showStatus) {
      // 手動更新時も、成功メッセージで画面を埋め尽くさない
      console.info("STOCK POINT: データを更新しました。");
    }
  } catch (error) {
    showGlobalMessage(
      "データの読み込みに失敗しました: " + friendlyError(error),
      "error"
    );
  } finally {
    isLoading = false;
    $("refresh-btn").disabled = !currentUser;
  }
}

/* ------------------------------
   株式一覧
------------------------------ */

function renderStocks() {
  const body = $("stocks-body");

  if (!stockList.length) {
    body.innerHTML =
      '<tr><td colspan="5">銘柄が登録されていません。</td></tr>';
    return;
  }

  body.innerHTML = stockList.map((stock) => {
    const price = Number(stock.price);
    const previous = Number(stock.previous_price);

    const change =
      Number.isFinite(price) && Number.isFinite(previous) && previous > 0
        ? ((price - previous) / previous) * 100
        : null;

    const changeClass =
      change === null ? "" : change > 0 ? "positive" : change < 0 ? "negative" : "";

    const changeText =
      change === null
        ? "—"
        : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`;

    return `
      <tr>
        <td>
          <div class="stock-name">${escapeHtml(stock.name)}</div>
          <div class="stock-id">${escapeHtml(stock.id)}</div>
        </td>
        <td>${formatPoints(price)}</td>
        <td class="${changeClass}">${changeText}</td>
        <td>${escapeHtml(formatDate(stock.updated_at))}</td>
        <td>
          <button type="button"
            class="small-btn"
            data-select-stock="${escapeHtml(stock.id)}">
            選択
          </button>
        </td>
      </tr>
    `;
  }).join("");
}

function renderTradeOptions() {
  const select = $("trade-stock");
  const oldValue = select.value;

  if (!stockList.length) {
    select.innerHTML = '<option value="">銘柄なし</option>';
    return;
  }

  select.innerHTML =
    '<option value="">銘柄を選択してください</option>' +
    stockList.map((stock) => `
      <option value="${escapeHtml(stock.id)}">
        ${escapeHtml(stock.name)} (${formatPoints(stock.price)})
      </option>
    `).join("");

  if (stockList.some((stock) => stock.id === oldValue)) {
    select.value = oldValue;
  } else {
    select.value = "";
  }
}

/* ------------------------------
   保有株
------------------------------ */

function renderHoldings() {
  const body = $("holdings-body");

  const nonZeroHoldings = holdingList.filter(
    (holding) => Number(holding.quantity) > 0
  );

  if (!nonZeroHoldings.length) {
    body.innerHTML =
      '<tr><td colspan="4">まだ株式を保有していません。</td></tr>';
    return;
  }

  body.innerHTML = nonZeroHoldings.map((holding) => {
    const stock = findStock(holding.stock_id);
    const price = Number(stock?.price || 0);
    const quantity = Number(holding.quantity);
    const value = price * quantity;

    return `
      <tr>
        <td>${escapeHtml(stockName(holding.stock_id))}</td>
        <td>${quantity.toLocaleString("ja-JP")} 株</td>
        <td>${formatPoints(price)}</td>
        <td>${formatPoints(value)}</td>
      </tr>
    `;
  }).join("");
}

/* ------------------------------
   資産表示
------------------------------ */

function calculateHoldingsValue() {
  return holdingList.reduce((sum, holding) => {
    const stock = findStock(holding.stock_id);

    if (!stock) return sum;

    return sum +
      Number(stock.price || 0) * Number(holding.quantity || 0);
  }, 0);
}

function renderSummary() {
  const cash = Number(currentProfile?.points || 0);
  const holdingsValue = calculateHoldingsValue();
  const total = cash + holdingsValue;
  const profit = total - INITIAL_POINTS;

  $("cash-value").textContent = formatPoints(cash);
  $("holdings-value").textContent = formatPoints(holdingsValue);
  $("total-value").textContent = formatPoints(total);

  const profitElement = $("profit-value");
  profitElement.textContent =
    `${profit > 0 ? "+" : ""}${formatPoints(profit)}`;

  profitElement.classList.remove("positive", "negative");

  if (profit > 0) {
    profitElement.classList.add("positive");
  } else if (profit < 0) {
    profitElement.classList.add("negative");
  }
}

/* ------------------------------
   ランキング
------------------------------ */

function renderRanking() {
  const list = $("ranking-list");

  if (!profileList.length) {
    list.innerHTML =
      "<li>ランキングを取得できません。profilesの読み取り権限を確認してください。</li>";
    return;
  }

  const ranking = profileList.map((profile) => {
    const holdingsValue = holdingList
      .filter((holding) => holding.user_id === profile.id)
      .reduce((sum, holding) => {
        const stock = findStock(holding.stock_id);

        if (!stock) return sum;

        return sum +
          Number(stock.price || 0) * Number(holding.quantity || 0);
      }, 0);

    return {
      id: profile.id,
      name: profile.display_name || "ユーザー",
      total: Number(profile.points || 0) + holdingsValue
    };
  });

  ranking.sort((a, b) => b.total - a.total);

  list.innerHTML = ranking.slice(0, 10).map((profile, index) => {
    const isMe = profile.id === currentUser?.id;

    return `
      <li>
        ${isMe ? "<strong>" : ""}
        ${index + 1}位：
        ${escapeHtml(profile.name)}
        — ${formatPoints(profile.total)}
        ${isMe ? "（自分）</strong>" : ""}
      </li>
    `;
  }).join("");
}

/* ------------------------------
   取引履歴
------------------------------ */

function renderTransactions() {
  const body = $("history-body");

  $("history-title").textContent =
    isAdmin() ? "全ユーザーの取引履歴" : "自分の取引履歴";

  if (!transactionList.length) {
    body.innerHTML =
      '<tr><td colspan="6">取引履歴はありません。</td></tr>';
    return;
  }

  body.innerHTML = transactionList.map((transaction) => {
    const side = String(transaction.side).toLowerCase();

    const sideLabel =
      side === "buy" ? "購入" :
      side === "sell" ? "売却" :
      transaction.side;

    return `
      <tr>
        <td>${escapeHtml(formatDate(transaction.created_at))}</td>
        <td>${escapeHtml(stockName(transaction.stock_id))}</td>
        <td>${escapeHtml(sideLabel)}</td>
        <td>${Number(transaction.quantity || 0).toLocaleString("ja-JP")}</td>
        <td>${formatPoints(transaction.price)}</td>
        <td>${formatPoints(transaction.total)}</td>
      </tr>
    `;
  }).join("");
}

/* ------------------------------
   売買金額の見積もり
------------------------------ */

function updateEstimate() {
  const stock = findStock($("trade-stock").value);
  const quantity = Number($("quantity").value);

  if (!stock || !Number.isSafeInteger(quantity) || quantity < 1) {
    $("estimate").textContent = "概算金額：—";
    return;
  }

  const total = Number(stock.price) * quantity;

  $("estimate").textContent =
    "概算金額：約 " + formatPoints(total);
}

/* ------------------------------
   売買
------------------------------ */

async function handleTrade(event) {
  event.preventDefault();

  if (!currentUser || !currentProfile || isTrading) return;

  const stockId = $("trade-stock").value;
  const side = $("trade-side").value;
  const quantity = Number($("quantity").value);

  if (!findStock(stockId)) {
    showMessage("trade-message", "銘柄を選択してください。", "error");
    return;
  }

  if (!["buy", "sell"].includes(side)) {
    showMessage("trade-message", "売買内容が正しくありません。", "error");
    return;
  }

  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > 1000000
  ) {
    showMessage(
      "trade-message",
      "数量は1〜1,000,000の整数で入力してください。",
      "error"
    );
    return;
  }

  isTrading = true;
  $("trade-submit").disabled = true;
  $("trade-submit").textContent = "取引中...";

  showMessage("trade-message", "");

  try {
    const { data, error } = await db.rpc("trade_stock", {
      p_stock_id: stockId,
      p_side: side,
      p_quantity: quantity
    });

    if (error) throw error;

    // RPC側で取引とポイント更新を実行する。
    // ブラウザからprofiles.pointsを直接変更しない。
    showMessage(
      "trade-message",
      `${side === "buy" ? "購入" : "売却"}が完了しました。`,
      "success"
    );

    await loadProfile();
    await loadDashboard();
  } catch (error) {
    showMessage("trade-message", friendlyError(error), "error");
  } finally {
    isTrading = false;
    $("trade-submit").disabled = false;
    $("trade-submit").textContent = "取引を実行";
  }
}

/* ------------------------------
   管理者：ポイント付与
------------------------------ */

async function handleGrantPoints(event) {
  event.preventDefault();

  if (!currentUser || !isAdmin() || isGranting) {
    showMessage(
      "admin-message",
      "管理者のみ利用できます。",
      "error"
    );
    return;
  }

  const targetUserId = $("grant-user").value.trim();
  const amount = Number($("grant-amount").value);

  // UUIDの形式を検証
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!uuidPattern.test(targetUserId)) {
    showMessage(
      "admin-message",
      "付与先ユーザーIDは正しいUUID形式で入力してください。",
      "error"
    );
    return;
  }

  if (
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > 100000000
  ) {
    showMessage(
      "admin-message",
      "付与ポイントは1〜100,000,000の整数で入力してください。",
      "error"
    );
    return;
  }

  isGranting = true;
  showMessage("admin-message", "");
  setButtonBusy("grant-form", false);

  const button = $("grant-form").querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = "付与中...";

  try {
    const { data, error } = await db.rpc("admin_grant_points", {
      p_target_user_id: targetUserId,
      p_amount: amount
    });

    if (error) throw error;

    const newBalance =
      data && data.new_points !== undefined
        ? formatPoints(data.new_points)
        : "更新済み";

    showMessage(
      "admin-message",
      `ポイントを付与しました。付与後残高：${newBalance}`,
      "success"
    );

    await loadDashboard();
  } catch (error) {
    showMessage("admin-message", friendlyError(error), "error");
  } finally {
    isGranting = false;
    button.disabled = false;
    button.textContent = "ポイントを付与";
  }
}

/* ------------------------------
   30秒ごとの画面更新
------------------------------ */

function startAutoRefresh() {
  stopAutoRefresh();

  refreshTimer = setInterval(async () => {
    if (currentUser && !isLoading && !isTrading && !isGranting) {
      await loadProfile();
      await loadDashboard();
    }
  }, REFRESH_INTERVAL);
}

function stopAutoRefresh() {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
