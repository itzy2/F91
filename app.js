/* =====================================================
   STOCK POINT
   Supabase接続・ログイン・株式売買・ランキング
   会社別株価グラフ対応
===================================================== */

const SUPABASE_URL = "https://qwswjasrorhstzueixcr.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_WarHJF6XeJEaAqhmu9djFA_puVUA4Br";

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
let stockChartLoading = false;
let stockChartRequestId = 0;

const $ = (id) => document.getElementById(id);

const yen = (value) =>
  `${Number(value || 0).toLocaleString("ja-JP")} pt`;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
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
  if (!element) return;

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
  $("auth-panel")?.classList.toggle("hidden", isLoggedIn);
  $("app-panel")?.classList.toggle("hidden", !isLoggedIn);
  $("user-area")?.classList.toggle("hidden", !isLoggedIn);
}

function getSelectedSide() {
  return document.querySelector('input[name="side"]:checked')?.value || "buy";
}

function getSelectedStock() {
  const stockId = $("trade-stock")?.value;

  return stockList.find(
    (stock) => String(stock.id) === String(stockId)
  );
}

function getMyHolding(stockId) {
  return holdingList.find((holding) =>
    String(holding.user_id) === String(currentUser?.id) &&
    String(holding.stock_id) === String(stockId)
  );
}

/* =====================================================
   初期化
===================================================== */

async function initializeApp() {
  const loginForm = $("login-form");

  if (!loginForm) {
    console.error("ログインフォーム login-form が見つかりません。");
    return;
  }

  const isConfigured =
    SUPABASE_URL.startsWith("https://") &&
    SUPABASE_PUBLISHABLE_KEY.length > 20;

  if (!isConfigured) {
    $("config-warning")?.classList.remove("hidden");

    setMessage(
      "login-message",
      "Supabaseの接続設定を確認してください。"
    );

    return;
  }

  if (!window.supabase?.createClient) {
    setMessage(
      "login-message",
      "Supabaseライブラリを読み込めません。index.htmlを確認してください。"
    );

    console.error("Supabase JavaScriptライブラリがありません。");
    return;
  }

  db = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY
  );

  // 株価グラフの表示領域を作成
  createStockChartPanel();

  loginForm.addEventListener("submit", handleLogin);

  $("logout-btn")?.addEventListener("click", handleLogout);

  $("refresh-btn")?.addEventListener(
    "click",
    () => refreshDashboard(true)
  );

  $("trade-form")?.addEventListener("submit", handleTrade);

  $("trade-stock")?.addEventListener("change", updateEstimate);

  $("quantity")?.addEventListener("input", updateEstimate);

  document.querySelectorAll('input[name="side"]').forEach((radio) => {
    radio.addEventListener("change", updateEstimate);
  });

  try {
    const { data, error } = await db.auth.getSession();

    if (error) throw error;

    if (data.session) {
      await handleSession(data.session);
    }
  } catch (error) {
    console.error("ログイン状態の確認に失敗しました:", error);

    setMessage(
      "login-message",
      friendlyError(error, "ログイン状態を確認できませんでした。")
    );
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

  if (!db) {
    setMessage("login-message", "Supabaseに接続できていません。");
    return;
  }

  const email = $("email")?.value.trim();
  const password = $("password")?.value;

  if (!email || !password) {
    setMessage(
      "login-message",
      "メールアドレスとパスワードを入力してください。"
    );
    return;
  }

  const button = $("login-form")?.querySelector('button[type="submit"]');

  if (button) {
    button.disabled = true;
    button.textContent = "ログイン中…";
  }

  setMessage("login-message", "");

  try {
    const { data, error } = await db.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;

    await handleSession(data.session);
  } catch (error) {
    console.error("ログインエラー:", error);

    setMessage(
      "login-message",
      friendlyError(
        error,
        "ログインできませんでした。入力内容とSupabaseの設定を確認してください。"
      )
    );
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "ログイン";
    }
  }
}

async function handleLogout() {
  if (!db) return;

  const button = $("logout-btn");

  if (button) button.disabled = true;

  try {
    const { error } = await db.auth.signOut();

    if (error) throw error;

    clearInterval(refreshTimer);
    refreshTimer = null;

    currentUser = null;
    currentProfile = null;

    stockChartRequestId++;
    stockChartLoading = false;

    clearDashboard();
    setLoggedInView(false);

    setMessage("login-message", "ログアウトしました。", true);
  } catch (error) {
    console.error("ログアウトエラー:", error);

    showGlobalMessage(
      friendlyError(error, "ログアウトできませんでした。"),
      true
    );
  } finally {
    if (button) button.disabled = false;
  }
}

/* =====================================================
   ログイン状態・プロフィール
===================================================== */

async function handleSession(session) {
  if (!session?.user) {
    currentUser = null;
    currentProfile = null;

    clearInterval(refreshTimer);
    refreshTimer = null;

    stockChartRequestId++;
    stockChartLoading = false;

    clearDashboard();
    setLoggedInView(false);

    return;
  }

  if (
    currentUser?.id === session.user.id &&
    currentProfile
  ) {
    setLoggedInView(true);
    return;
  }

  currentUser = session.user;
  currentProfile = null;

  setLoggedInView(true);

  if ($("whoami")) {
    $("whoami").textContent = "読み込み中…";
  }

  try {
    const { data: profile, error } = await db
      .from("profiles")
      .select("id, display_name, role, points")
      .eq("id", currentUser.id)
      .maybeSingle();

    if (error) throw error;

    if (!profile) {
      throw new Error(
        "プロフィールが見つかりません。profilesテーブルを確認してください。"
      );
    }

    currentProfile = profile;

    $("whoami").textContent =
      `${profile.display_name}（${profile.role === "admin" ? "管理者" : "一般ユーザー"}）`;

    $("history-title").textContent =
      profile.role === "admin"
        ? "全利用者の取引履歴"
        : "自分の取引履歴";

    $("admin-note")?.classList.toggle(
      "hidden",
      profile.role !== "admin"
    );

    await refreshDashboard();

    clearInterval(refreshTimer);

    refreshTimer = setInterval(
      () => refreshDashboard(),
      REFRESH_INTERVAL
    );
  } catch (error) {
    console.error("プロフィール読み込みエラー:", error);

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

  if ($("whoami")) $("whoami").textContent = "";

  if ($("stocks-body")) {
    $("stocks-body").textContent = "ログインしてください。";
  }

  if ($("holdings-body")) {
    $("holdings-body").textContent = "ログインしてください。";
  }

  if ($("history-body")) {
    $("history-body").textContent = "ログインしてください。";
  }

  if ($("ranking-list")) {
    $("ranking-list").textContent = "ログインしてください。";
  }

  if ($("cash-value")) $("cash-value").textContent = "—";
  if ($("holdings-value")) $("holdings-value").textContent = "—";
  if ($("total-value")) $("total-value").textContent = "—";
  if ($("profit-value")) $("profit-value").textContent = "—";

  if ($("stock-chart-current")) {
    $("stock-chart-current").textContent = "";
  }

  if ($("stock-chart-status")) {
    $("stock-chart-status").textContent = "ログインしてください。";
  }

  if ($("stock-chart-svg")) {
    $("stock-chart-svg").innerHTML = "";
  }

  if ($("stock-chart-select")) {
    $("stock-chart-select").innerHTML =
      '<option value="">ログインしてください</option>';
  }
}

/* =====================================================
   ダッシュボードの更新
===================================================== */

async function refreshDashboard(showNotice = false) {
  if (!db || !currentUser || isLoading) return;

  isLoading = true;

  if ($("refresh-btn")) {
    $("refresh-btn").disabled = true;
  }

  try {
    await loadStocks();
    await loadProfiles();
    await loadHoldings();
    await loadTransactions();

    renderDashboard();

    if ($("last-updated")) {
      $("last-updated").textContent =
        `最終確認 ${new Date().toLocaleTimeString("ja-JP", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        })}`;
    }

    if (showNotice) {
      showGlobalMessage("データを更新しました。");
    }
  } catch (error) {
    console.error("ダッシュボード更新エラー:", error);

    showGlobalMessage(
      friendlyError(error, "データを読み込めませんでした。"),
      true
    );
  } finally {
    isLoading = false;

    if ($("refresh-btn")) {
      $("refresh-btn").disabled = false;
    }
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

  const me = profileList.find(
    (profile) => String(profile.id) === String(currentUser.id)
  );

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
    stockList.map((stock) => [String(stock.id), stock])
  );

  const myHoldings = holdingList.filter(
    (holding) =>
      String(holding.user_id) === String(currentUser.id)
  );

  const holdingsValue = myHoldings.reduce((sum, holding) => {
    const stock = stockById[String(holding.stock_id)];

    if (!stock) return sum;

    return sum +
      Number(stock.price) * Number(holding.quantity);
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

  // 会社別株価グラフを更新
  loadStockChart();
}

function renderStockTable(myHoldings) {
  const body = $("stocks-body");

  if (!body) return;

  if (!stockList.length) {
    body.textContent = "株式データがありません。";
    return;
  }

  const holdingMap = Object.fromEntries(
    myHoldings.map((holding) => [
      String(holding.stock_id),
      holding.quantity
    ])
  );

  body.innerHTML = stockList.map((stock) => {
    const price = Number(stock.price);
    const previous = Number(stock.previous_price);
    const change = price - previous;

    const percent = previous > 0
      ? (change / previous) * 100
      : 0;

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
          <span class="stock-code">
            ${percent > 0 ? "+" : ""}${percent.toFixed(2)}%
          </span>
        </td>
        <td>
          ${Number(holdingMap[String(stock.id)] || 0).toLocaleString("ja-JP")} 株
        </td>
        <td>
          <div class="table-action">
            <button class="buy-shortcut" type="button"
              data-side="buy" data-stock="${escapeHtml(stock.id)}">購入</button>
            <button class="sell-shortcut" type="button"
              data-side="sell" data-stock="${escapeHtml(stock.id)}">売却</button>
            <button class="chart-shortcut" type="button"
              data-chart-stock="${escapeHtml(stock.id)}">グラフ</button>
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

  body.querySelectorAll("button[data-chart-stock]").forEach((button) => {
    button.addEventListener("click", () => {
      const select = $("stock-chart-select");

      if (select) {
        select.value = button.dataset.chartStock;
        loadStockChart();

        $("stock-chart-panel")?.scrollIntoView({
          behavior: "smooth",
          block: "start"
        });
      }
    });
  });
}

function renderStockSelect() {
  const select = $("trade-stock");

  if (!select) return;

  const previousValue = select.value;

  select.innerHTML = stockList.map((stock) => `
    <option value="${escapeHtml(stock.id)}">
      ${escapeHtml(stock.name)}（${yen(stock.price)}）
    </option>
  `).join("");

  if (
    stockList.some(
      (stock) => String(stock.id) === String(previousValue)
    )
  ) {
    select.value = previousValue;
  }
}

function renderHoldingsTable(myHoldings) {
  const body = $("holdings-body");

  if (!body) return;

  const nonZero = myHoldings.filter(
    (holding) => Number(holding.quantity) > 0
  );

  if (!nonZero.length) {
    body.textContent = "まだ株式を保有していません。";
    return;
  }

  const stockById = Object.fromEntries(
    stockList.map((stock) => [String(stock.id), stock])
  );

  body.innerHTML = nonZero.map((holding) => {
    const stock = stockById[String(holding.stock_id)];

    if (!stock) return "";

    return `
      <tr>
        <td class="stock-name">${escapeHtml(stock.name)}</td>
        <td>${Number(holding.quantity).toLocaleString("ja-JP")} 株</td>
        <td>${yen(stock.price)}</td>
        <td class="price">
          ${yen(Number(stock.price) * Number(holding.quantity))}
        </td>
      </tr>
    `;
  }).join("");
}

function renderRanking(stockById) {
  const list = $("ranking-list");

  if (!list) return;

  const ranking = profileList.map((profile) => {
    const value = holdingList
      .filter(
        (holding) =>
          String(holding.user_id) === String(profile.id)
      )
      .reduce((sum, holding) => {
        const stock = stockById[String(holding.stock_id)];

        if (!stock) return sum;

        return sum +
          Number(stock.price) * Number(holding.quantity);
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
    list.textContent = "ランキングデータがありません。";
    return;
  }

  list.innerHTML = ranking.map((item, index) => `
    <div class="ranking-item">
      <div class="rank-number ${index === 0 ? "first" : ""}">
        ${index + 1}
      </div>
      <div>
        <div class="rank-name">
          ${escapeHtml(item.name)}
          ${String(item.id) === String(currentUser.id) ? "（あなた）" : ""}
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

  if (!body) return;

  if (!transactionList.length) {
    body.textContent = "取引履歴はまだありません。";
    return;
  }

  const profileById = Object.fromEntries(
    profileList.map((profile) => [String(profile.id), profile])
  );

  body.innerHTML = transactionList.map((transaction) => {
    const stock = stockById[String(transaction.stock_id)];
    const profile = profileById[String(transaction.user_id)];

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
  const quantity = Number($("quantity")?.value || 0);

  if (
    !stock ||
    quantity <= 0 ||
    !Number.isInteger(quantity)
  ) {
    if ($("estimate")) $("estimate").textContent = "—";
    return;
  }

  $("estimate").textContent =
    yen(Number(stock.price) * quantity);
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

  if (
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 100000
  ) {
    setMessage(
      "trade-message",
      "株数は1〜100,000株の整数で入力してください。"
    );
    return;
  }

  const stock = stockList.find(
    (item) => String(item.id) === String(stockId)
  );

  if (!stock) {
    setMessage("trade-message", "銘柄データを読み込めませんでした。");
    return;
  }

  const total = Number(stock.price) * quantity;

  if (
    side === "buy" &&
    total > Number(currentProfile.points)
  ) {
    setMessage("trade-message", "ポイントが不足しています。");
    return;
  }

  if (side === "sell") {
    try {
      const { data: holding, error } = await db
        .from("holdings")
        .select("quantity")
        .eq("user_id", currentUser.id)
        .eq("stock_id", stockId)
        .maybeSingle();

      if (error) throw error;

      const actualQuantity = Number(holding?.quantity || 0);

      if (actualQuantity < quantity) {
        await refreshDashboard();

        setMessage(
          "trade-message",
          `保有株数は${actualQuantity.toLocaleString("ja-JP")}株です。売却株数を確認してください。`
        );

        return;
      }
    } catch (error) {
      console.error("保有株数の確認エラー:", error);

      setMessage(
        "trade-message",
        friendlyError(error, "保有株数を確認できませんでした。")
      );

      return;
    }
  }

  const actionName = side === "buy" ? "購入" : "売却";

  const confirmed = window.confirm(
    `${stock.name}\n` +
    `${actionName}株数：${quantity.toLocaleString("ja-JP")}株\n` +
    `概算金額：${yen(total)}\n\n` +
    "注文を確定しますか？"
  );

  if (!confirmed) return;

  const button = $("trade-submit");

  if (button) {
    button.disabled = true;
    button.textContent = "注文処理中…";
  }

  setMessage("trade-message", "");

  try {
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
    console.error("売買エラー:", error);

    setMessage(
      "trade-message",
      friendlyError(error, "注文に失敗しました。")
    );
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "注文を確定";
    }
  }
}

/* =====================================================
   会社別・株価グラフ
===================================================== */

function createStockChartPanel() {
  if ($("stock-chart-panel")) return;

  const stocksBody = $("stocks-body");
  const table = stocksBody?.closest("table");

  if (!table || !table.parentElement) {
    console.error("株式一覧テーブルが見つかりません。");
    return;
  }

  const panel = document.createElement("section");

  panel.id = "stock-chart-panel";

  panel.style.cssText = `
    margin: 24px 0;
    padding: 20px;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 16px;
    color: #172033;
    box-shadow: 0 4px 16px rgba(0,0,0,0.04);
  `;

  panel.innerHTML = `
    <h2 style="margin:0 0 8px;font-size:21px;">
      会社別 株価チャート
    </h2>

    <p style="margin:0 0 16px;color:#64748b;font-size:13px;">
      銘柄を選択して、記録された株価の推移を確認できます。
    </p>

    <label for="stock-chart-select"
      style="display:block;margin-bottom:6px;font-weight:bold;">
      会社・銘柄
    </label>

    <select id="stock-chart-select"
      style="width:100%;max-width:360px;padding:10px;border:1px solid #cbd5e1;border-radius:8px;">
      <option value="">銘柄を読み込み中...</option>
    </select>

    <div id="stock-chart-current"
      style="margin-top:18px;font-size:20px;font-weight:bold;">
    </div>

    <div id="stock-chart-status"
      role="status"
      style="margin-top:10px;color:#64748b;font-size:14px;">
      株価履歴を読み込みます。
    </div>

    <div style="width:100%;overflow-x:auto;margin-top:12px;">
      <svg id="stock-chart-svg"
        viewBox="0 0 720 300"
        role="img"
        aria-label="選択した銘柄の株価推移グラフ"
        style="display:block;width:100%;min-width:320px;height:auto;">
      </svg>
    </div>

    <p style="margin:12px 0 0;color:#64748b;font-size:12px;">
      ※ グラフは記録済みの株価履歴を表示します。
    </p>
  `;

  table.parentElement.insertBefore(panel, table);

  $("stock-chart-select").addEventListener("change", () => {
    loadStockChart();
  });
}

function updateStockChartSelect() {
  const select = $("stock-chart-select");

  if (!select) return;

  const previousValue = select.value;

  select.innerHTML = `
    <option value="">銘柄を選択してください</option>
    ${stockList.map((stock) => `
      <option value="${escapeHtml(stock.id)}">
        ${escapeHtml(stock.name)}
      </option>
    `).join("")}
  `;

  const previousStillExists = stockList.some(
    (stock) => String(stock.id) === String(previousValue)
  );

  if (previousStillExists) {
    select.value = previousValue;
  } else if (stockList.length > 0) {
    select.value = String(stockList[0].id);
  }
}

async function loadStockChart() {
  if (!db || !currentUser) return;

  const select = $("stock-chart-select");
  const status = $("stock-chart-status");
  const svg = $("stock-chart-svg");
  const current = $("stock-chart-current");

  if (!select || !status || !svg || !current) return;

  updateStockChartSelect();

  const stockId = select.value;

  if (!stockId) {
    status.textContent = "表示する銘柄がありません。";
    svg.innerHTML = "";
    current.textContent = "";
    return;
  }

  const stock = stockList.find(
    (item) => String(item.id) === String(stockId)
  );

  if (!stock) {
    status.textContent = "銘柄情報を取得できませんでした。";
    return;
  }

  current.textContent = `${stock.name}：${yen(stock.price)}`;

  // 連続操作時に、古い応答で新しいグラフを上書きしない
  const requestId = ++stockChartRequestId;

  status.textContent = "株価履歴を読み込み中...";

  try {
    const { data, error } = await db
      .from("stock_price_history")
      .select("price, recorded_at")
      .eq("stock_id", stockId)
      .order("recorded_at", { ascending: true })
      .limit(100);

    if (requestId !== stockChartRequestId) return;

    if (error) throw error;

    const history = data || [];

    if (history.length === 0) {
      svg.innerHTML = "";

      status.textContent =
        "まだ株価履歴がありません。株価が更新されると記録が追加されます。";

      return;
    }

    renderStockChart(history);

    status.textContent =
      `${history.length}件の株価履歴を表示しています。`;
  } catch (error) {
    if (requestId !== stockChartRequestId) return;

    console.error("株価グラフの読み込みエラー:", error);

    svg.innerHTML = "";

    status.textContent =
      "株価履歴を取得できませんでした。Supabaseのテーブル権限を確認してください。";
  }
}

function renderStockChart(history) {
  const svg = $("stock-chart-svg");

  if (!svg) return;

  const validHistory = history
    .map((item) => ({
      price: Number(item.price),
      recordedAt: new Date(item.recorded_at)
    }))
    .filter((item) =>
      Number.isFinite(item.price) &&
      Number.isFinite(item.recordedAt.getTime())
    );

  if (!validHistory.length) {
    svg.innerHTML = "";
    return;
  }

  const width = 720;
  const height = 300;

  const paddingLeft = 76;
  const paddingRight = 24;
  const paddingTop = 28;
  const paddingBottom = 48;

  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  const prices = validHistory.map((item) => item.price);

  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);

  // 株価がすべて同じでもグラフを表示できるようにする
  const spread = rawMax - rawMin;
  const padding = spread > 0
    ? spread * 0.15
    : Math.max(rawMax * 0.05, 1);

  const minPrice = Math.max(0, rawMin - padding);
  const maxPrice = rawMax + padding;
  const priceRange = maxPrice - minPrice || 1;

  const points = validHistory.map((item, index) => {
    const x = validHistory.length === 1
      ? paddingLeft + chartWidth / 2
      : paddingLeft +
        (index / (validHistory.length - 1)) * chartWidth;

    const y = paddingTop +
      ((maxPrice - item.price) / priceRange) * chartHeight;

    return { x, y, price: item.price, recordedAt: item.recordedAt };
  });

  const gridLines = 4;
  let gridSvg = "";

  for (let i = 0; i <= gridLines; i++) {
    const y = paddingTop + (chartHeight / gridLines) * i;
    const price = maxPrice - (priceRange / gridLines) * i;

    gridSvg += `
      <line
        x1="${paddingLeft}"
        y1="${y}"
        x2="${width - paddingRight}"
        y2="${y}"
        stroke="#e2e8f0"
        stroke-width="1"
      />
      <text
        x="${paddingLeft - 10}"
        y="${y + 4}"
        text-anchor="end"
        font-size="12"
        fill="#64748b"
      >${Math.round(price).toLocaleString("ja-JP")}</text>
    `;
  }

  const linePoints = points
    .map((point) => `${point.x},${point.y}`)
    .join(" ");

  const first = points[0];
  const last = points[points.length - 1];

  const areaPoints = [
    `${first.x},${paddingTop + chartHeight}`,
    ...points.map((point) => `${point.x},${point.y}`),
    `${last.x},${paddingTop + chartHeight}`
  ].join(" ");

  const startDate = validHistory[0].recordedAt.toLocaleDateString("ja-JP");
  const endDate = validHistory[validHistory.length - 1]
    .recordedAt.toLocaleDateString("ja-JP");

  const lastPrice = validHistory[validHistory.length - 1].price;
  const firstPrice = validHistory[0].price;
  const trendColor = lastPrice >= firstPrice ? "#16a34a" : "#dc2626";

  const circles = points.map((point) => `
    <circle
      cx="${point.x}"
      cy="${point.y}"
      r="3.5"
      fill="${trendColor}"
      stroke="#ffffff"
      stroke-width="1.5"
    >
      <title>${point.recordedAt.toLocaleString("ja-JP")}：${yen(point.price)}</title>
    </circle>
  `).join("");

  svg.innerHTML = `
    <rect width="${width}" height="${height}" fill="#ffffff" />

    ${gridSvg}

    <polygon
      points="${areaPoints}"
      fill="${trendColor}"
      opacity="0.10"
    />

    <polyline
      points="${linePoints}"
      fill="none"
      stroke="${trendColor}"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />

    ${circles}

    <text
      x="${paddingLeft}"
      y="${height - 16}"
      font-size="12"
      fill="#64748b"
    >${escapeHtml(startDate)}</text>

    <text
      x="${width - paddingRight}"
      y="${height - 16}"
      text-anchor="end"
      font-size="12"
      fill="#64748b"
    >${escapeHtml(endDate)}</text>
  `;
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
    return "メールアドレスの確認が必要です。";
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
    return "データベースのテーブルが見つかりません。Supabaseの設定を確認してください。";
  }

  if (
    message.includes("permission denied") ||
    message.includes("row-level security") ||
    message.includes("violates row-level security")
  ) {
    return "データベースのアクセス権限を確認してください。";
  }

  if (
    message.includes("Failed to fetch") ||
    message.includes("NetworkError")
  ) {
    return "Supabaseに接続できません。URLとネットワークを確認してください。";
  }

  return message || fallback;
}

/* =====================================================
   アプリ起動
===================================================== */

document.addEventListener("DOMContentLoaded", initializeApp);
