/* =====================================================
   STOCK POINT
   Supabase接続・ログイン・株式売買・ランキング
   ===================================================== */

/*
  【最初に設定すること】

  SUPABASE_URL:
    SupabaseのProject URL

  SUPABASE_PUBLISHABLE_KEY:
    SupabaseのPublishable key

  公開用キーだけを使用してください。
  service_roleキーやsecretキーは絶対に設定しないでください。
*/

const SUPABASE_URL = "https://qwswjasrorhstzueixcr.supabase.co/rest/v1/";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_WarHJF6XeJEaAqhmu9djFA_puVUA4Br";

/* 初期設定 */
const INITIAL_POINTS = 5000;
const REFRESH_INTERVAL = 60000;

let db = null;
let currentUser = null;
let currentProfile = null;
let stockList = [];
let holdingList = [];
let profileList = [];
let transactionList = [];
let refreshTimer = null;
let isLoading = false;

const $ = (id) => document.getElementById(id);

const yen = (value) =>
  `${Number(value || 0).toLocaleString("ja-JP")} pt`;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function setMessage(id, message, success = false) {
  const element = $(id);
  if (!element) return;

  element.textContent = message;
  element.classList.toggle("success", success);
}

function showGlobalMessage(message, warning = false) {
  const element = $("global-message");
  element.textContent = message;
  element.classList.remove("hidden", "warning");

  if (warning) {
    element.classList.add("warning");
  }

  window.setTimeout(() => {
    element.classList.add("hidden");
  }, 6000);
}

function setLoggedInView(isLoggedIn) {
  $("auth-panel").classList.toggle("hidden", isLoggedIn);
  $("app-panel").classList.toggle("hidden", !isLoggedIn);
  $("user-area").classList.toggle("hidden", !isLoggedIn);
}

function getSelectedSide() {
  return document.querySelector('input[name="side"]:checked')?.value || "buy";
}

function getSelectedStock() {
  const stockId = $("trade-stock").value;
  return stockList.find((stock) => stock.id === stockId);
}

function getMyHolding(stockId) {
  return holdingList.find((holding) => holding.stock_id === stockId);
}

/* =====================================================
   初期化
   ===================================================== */

async function initializeApp() {
  const isConfigured =
    SUPABASE_URL.startsWith("https://") &&
    !SUPABASE_URL.includes("ここに") &&
    SUPABASE_PUBLISHABLE_KEY.length > 20 &&
    !SUPABASE_PUBLISHABLE_KEY.includes("ここに");

  if (!isConfigured) {
    $("config-warning").classList.remove("hidden");
    $("login-form").querySelector("button[type=submit]").disabled = true;
    setMessage(
      "login-message",
      "app.jsのSupabase接続設定を入力してから利用してください。"
    );
    return;
  }

  if (!window.supabase?.createClient) {
    setMessage(
      "login-message",
      "Supabaseライブラリを読み込めません。通信環境を確認してください。"
    );
    return;
  }

  db = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY
  );

  $("login-form").addEventListener("submit", handleLogin);
  $("logout-btn").addEventListener("click", handleLogout);
  $("refresh-btn").addEventListener("click", () => refreshDashboard(true));
  $("trade-form").addEventListener("submit", handleTrade);

  $("trade-stock").addEventListener("change", updateEstimate);
  $("quantity").addEventListener("input", updateEstimate);

  document.querySelectorAll('input[name="side"]').forEach((radio) => {
    radio.addEventListener("change", updateEstimate);
  });

  const { data, error } = await db.auth.getSession();

  if (error) {
    setMessage("login-message", "ログイン状態を確認できませんでした。");
  } else if (data.session) {
    await handleSession(data.session);
  }

  db.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => {
      handleSession(session);
    }, 0);
  });
}

/* =====================================================
   ログイン
   ===================================================== */

async function handleLogin(event) {
  event.preventDefault();

  if (!db) return;

  const email = $("email").value.trim();
  const password = $("password").value;

  const button = $("login-form").querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "ログイン中…";
  setMessage("login-message", "");

  try {
    const { data, error } = await db.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;

    await handleSession(data.session);
  } catch (error) {
    setMessage(
      "login-message",
      friendlyError(error, "ログインできませんでした。メールアドレスとパスワードを確認してください。")
    );
  } finally {
    button.disabled = false;
    button.textContent = "ログイン";
  }
}

async function handleLogout() {
  if (!db) return;

  $("logout-btn").disabled = true;

  try {
    const { error } = await db.auth.signOut();
    if (error) throw error;

    clearDashboard();
    setLoggedInView(false);
    setMessage("login-message", "ログアウトしました。", true);
  } catch (error) {
    showGlobalMessage(friendlyError(error, "ログアウトできませんでした。"), true);
  } finally {
    $("logout-btn").disabled = false;
  }
}

/* =====================================================
   ログイン状態
   ===================================================== */

async function handleSession(session) {
  if (!session?.user) {
    currentUser = null;
    currentProfile = null;
    clearInterval(refreshTimer);
    refreshTimer = null;
    setLoggedInView(false);
    return;
  }

  if (currentUser?.id === session.user.id && currentProfile) {
    setLoggedInView(true);
    return;
  }

  currentUser = session.user;
  setLoggedInView(true);

  $("whoami").textContent = "読み込み中…";

  try {
    const { data: profile, error } = await db
      .from("profiles")
      .select("id, display_name, role, points")
      .eq("id", currentUser.id)
      .maybeSingle();

    if (error) throw error;

    if (!profile) {
      throw new Error(
        "プロフィールが見つかりません。Supabaseのprofilesテーブルを確認してください。"
      );
    }

    currentProfile = profile;
    $("whoami").textContent =
      `${profile.display_name}（${profile.role === "admin" ? "管理者" : "一般ユーザー"}）`;

    $("history-title").textContent =
      profile.role === "admin" ? "全利用者の取引履歴" : "自分の取引履歴";

    $("admin-note").classList.toggle(
      "hidden",
      profile.role !== "admin"
    );

    await refreshDashboard();

    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => refreshDashboard(), REFRESH_INTERVAL);
  } catch (error) {
    showGlobalMessage(
      friendlyError(error, "プロフィールを読み込めませんでした。"),
      true
    );
  }
}

function clearDashboard() {
  stockList = [];
  holdingList = [];
  profileList = [];
  transactionList = [];
  currentProfile = null;

  $("whoami").textContent = "";
  $("stocks-body").innerHTML = '<tr><td colspan="5" class="empty">ログインしてください。</td></tr>';
  $("holdings-body").innerHTML = '<tr><td colspan="4" class="empty">ログインしてください。</td></tr>';
  $("history-body").innerHTML = '<tr><td colspan="7" class="empty">ログインしてください。</td></tr>';
  $("ranking-list").innerHTML = '<p class="empty">ログインしてください。</p>';

  $("cash-value").textContent = "—";
  $("holdings-value").textContent = "—";
  $("total-value").textContent = "—";
  $("profit-value").textContent = "—";
}

/* =====================================================
   ダッシュボードの更新
   ===================================================== */

async function refreshDashboard(showNotice = false) {
  if (!db || !currentUser || isLoading) return;

  isLoading = true;
  $("refresh-btn").disabled = true;

  try {
    await loadStocks();
    await loadProfiles();
    await loadHoldings();
    await loadTransactions();

    renderDashboard();

    $("last-updated").textContent =
      `最終確認 ${new Date().toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      })}`;

    if (showNotice) {
      showGlobalMessage("データを更新しました。");
    }
  } catch (error) {
    showGlobalMessage(
      friendlyError(error, "データを読み込めませんでした。"),
      true
    );
  } finally {
    isLoading = false;
    $("refresh-btn").disabled = false;
  }
}

async function loadStocks() {
  const { data, error } = await db
    .from("stocks")
    .select("id, name, price, previous_price, updated_at")
    .order("id");

  if (error) throw error;

  stockList = data || [];
}

async function loadProfiles() {
  const { data, error } = await db
    .from("profiles")
    .select("id, display_name, role, points");

  if (error) throw error;

  profileList = data || [];

  const me = profileList.find((profile) => profile.id === currentUser.id);

  if (me) currentProfile = me;
}

async function loadHoldings() {
  const { data, error } = await db
    .from("holdings")
    .select("user_id, stock_id, quantity");

  if (error) throw error;

  holdingList = data || [];
}

async function loadTransactions() {
  let query = db
    .from("transactions")
    .select("id, user_id, stock_id, side, quantity, price, total, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  /*
    RLSでも制限していますが、一般ユーザーは本人の履歴だけを
    要求するようにしています。管理者は全履歴を要求します。
  */
  if (currentProfile?.role !== "admin") {
    query = query.eq("user_id", currentUser.id);
  }

  const { data, error } = await query;

  if (error) throw error;

  transactionList = data || [];
}

/* =====================================================
   画面表示
   ===================================================== */

function renderDashboard() {
  if (!currentProfile) return;

  const stockById = Object.fromEntries(
    stockList.map((stock) => [stock.id, stock])
  );

  const myHoldings = holdingList.filter(
    (holding) => holding.user_id === currentUser.id
  );

  const holdingsValue = myHoldings.reduce((sum, holding) => {
    const stock = stockById[holding.stock_id];
    if (!stock) return sum;

    return sum + Number(stock.price) * Number(holding.quantity);
  }, 0);

  const cash = Number(currentProfile.points || 0);
  const total = cash + holdingsValue;
  const profit = total - INITIAL_POINTS;

  $("cash-value").textContent = yen(cash);
  $("holdings-value").textContent = yen(holdingsValue);
  $("total-value").textContent = yen(total);

  const profitElement = $("profit-value");
  profitElement.textContent =
    `${profit > 0 ? "+" : ""}${yen(profit)}`;
  profitElement.classList.toggle("positive", profit > 0);
  profitElement.classList.toggle("negative", profit < 0);

  renderStockTable(myHoldings);
  renderStockSelect();
  renderHoldingsTable(myHoldings);
  renderRanking(stockById);
  renderHistory(stockById);

  updateEstimate();
}

function renderStockTable(myHoldings) {
  const body = $("stocks-body");

  if (!stockList.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">株式データがありません。</td></tr>';
    return;
  }

  const holdingMap = Object.fromEntries(
    myHoldings.map((holding) => [holding.stock_id, holding.quantity])
  );

  body.innerHTML = stockList.map((stock) => {
    const price = Number(stock.price);
    const previous = Number(stock.previous_price);
    const change = price - previous;
    const percent = previous > 0 ? (change / previous) * 100 : 0;

    let changeClass = "change-flat";
    let changeText = "±0 pt";

    if (change > 0) {
      changeClass = "change-up";
      changeText = `+${change.toLocaleString("ja-JP")} pt`;
    } else if (change < 0) {
      changeClass = "change-down";
      changeText = `${change.toLocaleString("ja-JP")} pt`;
    }

    return `
      <tr>
        <td class="stock-name">
          ${escapeHtml(stock.name)}
          <span class="stock-code">${escapeHtml(stock.id)}</span>
        </td>
        <td class="price">${yen(price)}</td>
        <td class="${changeClass}">
          ${changeText}
          <span class="stock-code">${percent > 0 ? "+" : ""}${percent.toFixed(2)}%</span>
        </td>
        <td>${Number(holdingMap[stock.id] || 0).toLocaleString("ja-JP")} 株</td>
        <td>
          <div class="table-action">
            <button class="buy-shortcut" type="button" data-side="buy" data-stock="${escapeHtml(stock.id)}">購入</button>
            <button class="sell-shortcut" type="button" data-side="sell" data-stock="${escapeHtml(stock.id)}">売却</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  body.querySelectorAll("button[data-stock]").forEach((button) => {
    button.addEventListener("click", () => {
      $("trade-stock").value = button.dataset.stock;

      const radio = document.querySelector(
        `input[name="side"][value="${button.dataset.side}"]`
      );

      if (radio) radio.checked = true;

      updateEstimate();

      $("trade-stock").scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    });
  });
}

function renderStockSelect() {
  const select = $("trade-stock");
  const previousValue = select.value;

  select.innerHTML = stockList.map((stock) => `
    <option value="${escapeHtml(stock.id)}">
      ${escapeHtml(stock.name)}（${yen(stock.price)}）
    </option>
  `).join("");

  if (stockList.some((stock) => stock.id === previousValue)) {
    select.value = previousValue;
  }
}

function renderHoldingsTable(myHoldings) {
  const body = $("holdings-body");
  const nonZero = myHoldings.filter((holding) => Number(holding.quantity) > 0);

  if (!nonZero.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">まだ株式を保有していません。</td></tr>';
    return;
  }

  const stockById = Object.fromEntries(
    stockList.map((stock) => [stock.id, stock])
  );

  body.innerHTML = nonZero.map((holding) => {
    const stock = stockById[holding.stock_id];
    if (!stock) return "";

    return `
      <tr>
        <td class="stock-name">${escapeHtml(stock.name)}</td>
        <td>${Number(holding.quantity).toLocaleString("ja-JP")} 株</td>
        <td>${yen(stock.price)}</td>
        <td class="price">${yen(Number(stock.price) * Number(holding.quantity))}</td>
      </tr>
    `;
  }).join("");
}

function renderRanking(stockById) {
  const ranking = profileList.map((profile) => {
    const value = holdingList
      .filter((holding) => holding.user_id === profile.id)
      .reduce((sum, holding) => {
        const stock = stockById[holding.stock_id];
        if (!stock) return sum;

        return sum + Number(stock.price) * Number(holding.quantity);
      }, 0);

    return {
      id: profile.id,
      name: profile.display_name,
      total: Number(profile.points || 0) + value,
      points: Number(profile.points || 0),
      holdingsValue: value
    };
  }).sort((a, b) => b.total - a.total);

  if (!ranking.length) {
    $("ranking-list").innerHTML = '<p class="empty">ランキングデータがありません。</p>';
    return;
  }

  $("ranking-list").innerHTML = ranking.map((item, index) => `
    <div class="ranking-item">
      <div class="rank-number ${index === 0 ? "first" : ""}">
        ${index + 1}
      </div>
      <div>
        <div class="rank-name">
          ${escapeHtml(item.name)}
          ${item.id === currentUser.id ? "（あなた）" : ""}
        </div>
        <div class="rank-caption">
          ポイント ${yen(item.points)} · 株式 ${yen(item.holdingsValue)}
        </div>
      </div>
      <div class="rank-total">${yen(item.total)}</div>
    </div>
  `).join("");
}

function renderHistory(stockById) {
  const body = $("history-body");

  if (!transactionList.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">取引履歴はまだありません。</td></tr>';
    return;
  }

  const profileById = Object.fromEntries(
    profileList.map((profile) => [profile.id, profile])
  );

  body.innerHTML = transactionList.map((transaction) => {
    const stock = stockById[transaction.stock_id];
    const profile = profileById[transaction.user_id];

    const date = new Date(transaction.created_at);
    const dateText = Number.isNaN(date.getTime())
      ? "日時不明"
      : date.toLocaleString("ja-JP");

    const isBuy = transaction.side === "buy";

    return `
      <tr>
        <td>${escapeHtml(dateText)}</td>
        <td>${escapeHtml(profile?.display_name || "ユーザー")}</td>
        <td>${escapeHtml(stock?.name || transaction.stock_id)}</td>
        <td class="${isBuy ? "change-up" : "change-down"}">
          ${isBuy ? "購入" : "売却"}
        </td>
        <td>${Number(transaction.quantity).toLocaleString("ja-JP")} 株</td>
        <td>${yen(transaction.price)}</td>
        <td class="price">${yen(transaction.total)}</td>
      </tr>
    `;
  }).join("");
}

/* =====================================================
   注文金額の計算
   ===================================================== */

function updateEstimate() {
  const stock = getSelectedStock();
  const quantity = Number($("quantity").value || 0);

  if (!stock || quantity <= 0 || !Number.isInteger(quantity)) {
    $("estimate").textContent = "—";
    return;
  }

  $("estimate").textContent = yen(Number(stock.price) * quantity);
}

/* =====================================================
   株式売買
   ===================================================== */

async function handleTrade(event) {
  event.preventDefault();

  if (!db || !currentUser || !currentProfile) {
    setMessage("trade-message", "ログインしてください。");
    return;
  }

  const stockId = $("trade-stock").value;
  const side = getSelectedSide();
  const quantity = Number($("quantity").value);

  if (!stockId) {
    setMessage("trade-message", "銘柄を選択してください。");
    return;
  }

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) {
    setMessage("trade-message", "株数は1〜100,000株の整数で入力してください。");
    return;
  }

  const stock = stockList.find((item) => item.id === stockId);

  if (!stock) {
    setMessage("trade-message", "銘柄データを読み込めませんでした。");
    return;
  }

  const total = Number(stock.price) * quantity;

  if (side === "buy" && total > Number(currentProfile.points)) {
    setMessage("trade-message", "ポイントが不足しています。");
    return;
  }

  const holding = getMyHolding(stockId);

  if (side === "sell" && Number(holding?.quantity || 0) < quantity) {
    setMessage("trade-message", "売却する株数が保有株数を超えています。");
    return;
  }

  const actionName = side === "buy" ? "購入" : "売却";
  const confirmed = window.confirm(
    `${stock.name}\n${actionName}株数：${quantity.toLocaleString("ja-JP")}株\n` +
    `概算金額：${yen(total)}\n\n注文を確定しますか？`
  );

  if (!confirmed) return;

  const button = $("trade-submit");
  button.disabled = true;
  button.textContent = "注文処理中…";
  setMessage("trade-message", "");

  try {
    /*
      売買処理はSupabaseの関数で行います。
      ブラウザー側からポイントや保有株を直接変更しません。
    */
    const { data, error } = await db.rpc("trade_stock", {
      p_stock_id: stockId,
      p_side: side,
      p_quantity: quantity
    });

    if (error) throw error;

    if (!data?.success) {
      throw new Error("注文結果を確認できませんでした。");
    }

    setMessage(
      "trade-message",
      `${actionName}が完了しました。取引額：${yen(data.total)}`,
      true
    );

    await refreshDashboard();
  } catch (error) {
    setMessage(
      "trade-message",
      friendlyError(error, "注文に失敗しました。")
    );
  } finally {
    button.disabled = false;
    button.textContent = "注文を確定";
  }
}

/* =====================================================
   エラー表示
   ===================================================== */

function friendlyError(error, fallback) {
  const message = String(error?.message || "");

  if (message.includes("Invalid login credentials")) {
    return "メールアドレスまたはパスワードが違います。";
  }

  if (message.includes("Email not confirmed")) {
    return "メールアドレスの確認が必要です。SupabaseのAuthentication設定を確認してください。";
  }

  if (message.includes("ポイントが不足")) {
    return "ポイントが不足しています。";
  }

  if (message.includes("保有株数が不足")) {
    return "売却する株数が保有株数を超えています。";
  }

  if (message.includes("ログインしてください")) {
    return "ログイン状態を確認してください。";
  }

  if (
    message.includes("relation") ||
    message.includes("does not exist")
  ) {
    return "データベースのテーブルが見つかりません。SupabaseのSQL設定を確認してください。";
  }

  if (
    message.includes("permission denied") ||
    message.includes("row-level security") ||
    message.includes("violates row-level security")
  ) {
    return "データベースのアクセス権限を確認してください。";
  }

  if (message.includes("Failed to fetch")) {
    return "Supabaseに接続できません。Project URLとネットワークを確認してください。";
  }

  return message || fallback;
}

/* アプリを起動 */
document.addEventListener("DOMContentLoaded", initializeApp);
