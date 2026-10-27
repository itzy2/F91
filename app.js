```javascript
/* =====================================================
   STOCK POINT
   Supabase接続・ログイン・株式売買・ランキング
   ===================================================== */

/*
  Supabase設定

  公開用のPublishable keyのみ使用してください。
  service_roleキーやsecretキーは使用しないでください。
*/

const SUPABASE_URL =
  "https://qwswjasrorhstzueixcr.supabase.co";

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

const $ = (id) => document.getElementById(id);

/* =====================================================
   共通処理
   ===================================================== */

function yen(value) {
  return `${Number(value || 0).toLocaleString("ja-JP")} pt`;
}

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
  $("auth-panel").classList.toggle("hidden", isLoggedIn);
  $("app-panel").classList.toggle("hidden", !isLoggedIn);
  $("user-area").classList.toggle("hidden", !isLoggedIn);
}

function getSelectedSide() {
  return document.querySelector(
    'input[name="side"]:checked'
  )?.value || "buy";
}

function getSelectedStock() {
  const stockId = $("trade-stock").value;

  return stockList.find(
    (stock) => String(stock.id) === String(stockId)
  );
}

/*
  画面上の保有株情報を検索する。
  売却の最終判定には、この情報だけを使用しない。
*/
function getMyHolding(stockId) {
  return holdingList.find(
    (holding) =>
      String(holding.user_id) === String(currentUser?.id) &&
      String(holding.stock_id) === String(stockId)
  );
}

/* =====================================================
   初期化
   ===================================================== */

async function initializeApp() {
  const isConfigured =
    SUPABASE_URL.startsWith("https://") &&
    SUPABASE_PUBLISHABLE_KEY.length > 20;

  if (!isConfigured) {
    $("config-warning").classList.remove("hidden");

    setMessage(
      "login-message",
      "Supabaseの接続設定を確認してください。"
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

  $("refresh-btn").addEventListener(
    "click",
    () => refreshDashboard(true)
  );

  $("trade-form").addEventListener("submit", handleTrade);

  $("trade-stock").addEventListener(
    "change",
    updateEstimate
  );

  $("quantity").addEventListener(
    "input",
    updateEstimate
  );

  document.querySelectorAll(
    'input[name="side"]'
  ).forEach((radio) => {
    radio.addEventListener("change", updateEstimate);
  });

  const { data, error } = await db.auth.getSession();

  if (error) {
    setMessage(
      "login-message",
      "ログイン状態を確認できませんでした。"
    );
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

  const button = $("login-form").querySelector(
    'button[type="submit"]'
  );

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
      friendlyError(
        error,
        "ログインできませんでした。メールアドレスとパスワードを確認してください。"
      )
    );

  } finally {
    button.disabled = false;
    button.textContent = "ログイン";
  }
}

/* =====================================================
   ログアウト
   ===================================================== */

async function handleLogout() {
  if (!db) return;

  $("logout-btn").disabled = true;

  try {
    const { error } = await db.auth.signOut();

    if (error) throw error;

    clearDashboard();
    setLoggedInView(false);

    setMessage(
      "login-message",
      "ログアウトしました。",
      true
    );

  } catch (error) {
    showGlobalMessage(
      friendlyError(error, "ログアウトできませんでした。"),
      true
    );

  } finally {
    $("logout-btn").disabled = false;
  }
}

/* =====================================================
   ログイン状態の管理
   ===================================================== */

async function handleSession(session) {
  if (!session?.user) {
    currentUser = null;
    currentProfile = null;

    clearInterval(refreshTimer);
    refreshTimer = null;

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
        "プロフィールが見つかりません。profilesテーブルを確認してください。"
      );
    }

    currentProfile = profile;

    $("whoami").textContent =
      `${profile.display_name}（${
        profile.role === "admin"
          ? "管理者"
          : "一般ユーザー"
      }）`;

    $("history-title").textContent =
      profile.role === "admin"
        ? "全利用者の取引履歴"
        : "自分の取引履歴";

    $("admin-note").classList.toggle(
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
    showGlobalMessage(
      friendlyError(error, "プロフィールを読み込めませんでした。"),
      true
    );
  }
}

/* =====================================================
   ダッシュボード初期化
   ===================================================== */

function clearDashboard() {
  stockList = [];
  holdingList = [];
  profileList = [];
  transactionList = [];

  currentProfile = null;

  $("whoami").textContent = "";

  $("stocks-body").innerHTML =
    '<tr><td colspan="5" class="empty">ログインしてください。</td></tr>';

  $("holdings-body").innerHTML =
    '<tr><td colspan="4" class="empty">ログインしてください。</td></tr>';

  $("history-body").innerHTML =
    '<tr><td colspan="7" class="empty">ログインしてください。</td></tr>';

  $("ranking-list").innerHTML =
    '<p class="empty">ログインしてください。</p>';

  $("cash-value").textContent = "—";
  $("holdings-value").textContent = "—";
  $("total-value").textContent = "—";
  $("profit-value").textContent = "—";

  $("trade-stock").innerHTML = "";
  $("estimate").textContent = "—";
}

/* =====================================================
   データの再読み込み
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

    if ($("refresh-btn")) {
      $("refresh-btn").disabled = false;
    }
  }
}

/* =====================================================
   株式データ
   ===================================================== */

async function loadStocks() {
  const { data, error } = await db
    .from("stocks")
    .select("id, name, price, previous_price, updated_at")
    .order("id");

  if (error) throw error;

  stockList = data || [];
}

/* =====================================================
   プロフィール
   ===================================================== */

async function loadProfiles() {
  const { data, error } = await db
    .from("profiles")
    .select("id, display_name, role, points");

  if (error) throw error;

  profileList = data || [];

  const me = profileList.find(
    (profile) => profile.id === currentUser.id
  );

  if (me) {
    currentProfile = me;
  }
}

/* =====================================================
   保有株
   ===================================================== */

async function loadHoldings() {
  const { data, error } = await db
    .from("holdings")
    .select("user_id, stock_id, quantity");

  if (error) throw error;

  holdingList = data || [];
}

/* =====================================================
   取引履歴
   ===================================================== */

async function loadTransactions() {
  let query = db
    .from("transactions")
    .select(
      "id, user_id, stock_id, side, quantity, price, total, created_at"
    )
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
   ダッシュボード表示
   ===================================================== */

function renderDashboard() {
  if (!currentProfile) return;

  const stockById = Object.fromEntries(
    stockList.map((stock) => [
      String(stock.id),
      stock
    ])
  );

  const myHoldings = holdingList.filter(
    (holding) =>
      String(holding.user_id) === String(currentUser.id)
  );

  const holdingsValue = myHoldings.reduce(
    (sum, holding) => {
      const stock = stockById[String(holding.stock_id)];

      if (!stock) return sum;

      return sum +
        Number(stock.price) * Number(holding.quantity);
    },
    0
  );

  const cash = Number(currentProfile.points || 0);
  const total = cash + holdingsValue;
  const profit = total - INITIAL_POINTS;

  $("cash-value").textContent = yen(cash);
  $("holdings-value").textContent = yen(holdingsValue);
  $("total-value").textContent = yen(total);

  $("profit-value").textContent =
    `${profit > 0 ? "+" : ""}${yen(profit)}`;

  $("profit-value").classList.toggle(
    "positive",
    profit > 0
  );

  $("profit-value").classList.toggle(
    "negative",
    profit < 0
  );

  renderStockTable(myHoldings);
  renderStockSelect();
  renderHoldingsTable(myHoldings);
  renderRanking(stockById);
  renderHistory(stockById);

  updateEstimate();
}

/* =====================================================
   株価一覧
   ===================================================== */

function renderStockTable(myHoldings) {
  const body = $("stocks-body");

  if (!stockList.length) {
    body.innerHTML =
      '<tr><td colspan="5" class="empty">株式データがありません。</td></tr>';

    return;
  }

  const holdingMap = Object.fromEntries(
    myHoldings.map((holding) => [
      String(holding.stock_id),
      Number(holding.quantity)
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
      changeText =
        `+${change.toLocaleString("ja-JP")} pt`;

    } else if (change < 0) {
      changeClass = "change-down";
      changeText =
        `${change.toLocaleString("ja-JP")} pt`;
    }

    return `
      <tr>
        <td class="stock-name">
          ${escapeHtml(stock.name)}
          <span class="stock-code">
            ${escapeHtml(stock.id)}
          </span>
        </td>

        <td class="price">${yen(price)}</td>

        <td class="${changeClass}">
          ${changeText}
          <span class="stock-code">
            ${percent > 0 ? "+" : ""}${percent.toFixed(2)}%
          </span>
        </td>

        <td>
          ${Number(
            holdingMap[String(stock.id)] || 0
          ).toLocaleString("ja-JP")} 株
        </td>

        <td>
          <div class="table-action">
            <button
              class="buy-shortcut"
              type="button"
              data-side="buy"
              data-stock="${escapeHtml(stock.id)}"
            >購入</button>

            <button
              class="sell-shortcut"
              type="button"
              data-side="sell"
              data-stock="${escapeHtml(stock.id)}"
            >売却</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  body.querySelectorAll("button[data-stock]").forEach(
    (button) => {
      button.addEventListener("click", () => {
        $("trade-stock").value = button.dataset.stock;

        const radio = document.querySelector(
          `input[name="side"][value="${button.dataset.side}"]`
        );

        if (radio) {
          radio.checked = true;
        }

        updateEstimate();

        $("trade-stock").scrollIntoView({
          behavior: "smooth",
          block: "center"
        });
      });
    }
  );
}

/* =====================================================
   注文銘柄選択
   ===================================================== */

function renderStockSelect() {
  const select = $("trade-stock");
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

/* =====================================================
   保有株一覧
   ===================================================== */

function renderHoldingsTable(myHoldings) {
  const body = $("holdings-body");

  const nonZero = myHoldings.filter(
    (holding) => Number(holding.quantity) > 0
  );

  if (!nonZero.length) {
    body.innerHTML =
      '<tr><td colspan="4" class="empty">まだ株式を保有していません。</td></tr>';

    return;
  }

  const stockById = Object.fromEntries(
    stockList.map((stock) => [
      String(stock.id),
      stock
    ])
  );

  body.innerHTML = nonZero.map((holding) => {
    const stock = stockById[String(holding.stock_id)];

    if (!stock) return "";

    return `
      <tr>
        <td class="stock-name">
          ${escapeHtml(stock.name)}
        </td>

        <td>
          ${Number(holding.quantity).toLocaleString("ja-JP")} 株
        </td>

        <td>${yen(stock.price)}</td>

        <td class="price">
          ${yen(
            Number(stock.price) * Number(holding.quantity)
          )}
        </td>
      </tr>
    `;
  }).join("");
}

/* =====================================================
   資産ランキング
   ===================================================== */

function renderRanking(stockById) {
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
    $("ranking-list").innerHTML =
      '<p class="empty">ランキングデータがありません。</p>';

    return;
  }

  $("ranking-list").innerHTML = ranking.map(
    (item, index) => `
      <div class="ranking-item">
        <div class="rank-number ${index === 0 ? "first" : ""}">
          ${index + 1}
        </div>

        <div>
          <div class="rank-name">
            ${escapeHtml(item.name)}
            ${
              String(item.id) === String(currentUser.id)
                ? "（あなた）"
                : ""
            }
          </div>

          <div class="rank-caption">
            ポイント ${yen(item.points)}
            · 株式 ${yen(item.holdingsValue)}
          </div>
        </div>

        <div class="rank-total">${yen(item.total)}</div>
      </div>
    `
  ).join("");
}

/* =====================================================
   取引履歴
   ===================================================== */

function renderHistory(stockById) {
  const body = $("history-body");

  if (!transactionList.length) {
    body.innerHTML =
      '<tr><td colspan="7" class="empty">取引履歴はまだありません。</td></tr>';

    return;
  }

  const profileById = Object.fromEntries(
    profileList.map((profile) => [
      String(profile.id),
      profile
    ])
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

        <td>
          ${escapeHtml(profile?.display_name || "ユーザー")}
        </td>

        <td>
          ${escapeHtml(stock?.name || transaction.stock_id)}
        </td>

        <td class="${isBuy ? "change-up" : "change-down"}">
          ${isBuy ? "購入" : "売却"}
        </td>

        <td>
          ${Number(transaction.quantity).toLocaleString("ja-JP")} 株
        </td>

        <td>${yen(transaction.price)}</td>

        <td class="price">${yen(transaction.total)}</td>
      </tr>
    `;
  }).join("");
}

/* =====================================================
   注文金額
   ===================================================== */

function updateEstimate() {
  const stock = getSelectedStock();
  const quantity = Number($("quantity").value || 0);

  if (
    !stock ||
    quantity <= 0 ||
    !Number.isInteger(quantity)
  ) {
    $("estimate").textContent = "—";
    return;
  }

  $("estimate").textContent = yen(
    Number(stock.price) * quantity
  );
}

/* =====================================================
   株式売買
   ===================================================== */

async function handleTrade(event) {
  event.preventDefault();

  if (isTrading) return;

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

  if (!["buy", "sell"].includes(side)) {
    setMessage("trade-message", "取引種類が正しくありません。");
    return;
  }

  const stock = stockList.find(
    (item) => String(item.id) === String(stockId)
  );

  if (!stock) {
    setMessage(
      "trade-message",
      "銘柄データを読み込めませんでした。更新してください。"
    );

    return;
  }

  /*
    注文前に保有株を再取得する。
    画面に残っている古いholdingListだけで判定しない。
  */

  isTrading = true;

  const button = $("trade-submit");

  button.disabled = true;
  button.textContent = "注文処理中…";

  setMessage("trade-message", "");

  try {
    if (side === "sell") {
      const { data: holding, error: holdingError } = await db
        .from("holdings")
        .select("quantity")
        .eq("user_id", currentUser.id)
        .eq("stock_id", stockId)
        .maybeSingle();

      if (holdingError) {
        throw holdingError;
      }

      const owned = Number(holding?.quantity ?? 0);

      /*
        最新のDB情報で判定する。
        1株保有・1株売却なら、この条件には該当しない。
      */

      if (owned < quantity) {
        await refreshDashboard();

        setMessage(
          "trade-message",
          `保有株数が不足しています。現在の保有株数：${owned}株`
        );

        return;
      }
    }

    /*
      購入・売却の最終判定と更新は
      Supabaseのtrade_stock関数で行う。
    */

    const actionName = side === "buy" ? "購入" : "売却";

    const latestTotal = Number(stock.price) * quantity;

    const confirmed = window.confirm(
      `${stock.name}\n` +
      `${actionName}株数：${quantity.toLocaleString("ja-JP")}株\n` +
      `概算金額：${yen(latestTotal)}\n\n` +
      `注文を確定しますか？`
    );

    if (!confirmed) return;

    const { data, error } = await db.rpc("trade_stock", {
      p_stock_id: stockId,
      p_side: side,
      p_quantity: quantity
    });

    if (error) {
      throw error;
    }

    if (!data?.success) {
      throw new Error("注文結果を確認できませんでした。");
    }

    /*
      注文成功後、ポイント・保有株・履歴を再取得する。
    */

    await refreshDashboard();

    setMessage(
      "trade-message",
      `${actionName}が完了しました。取引額：${yen(data.total)}`,
      true
    );

  } catch (error) {
    console.error("STOCK POINT trade error:", error);

    setMessage(
      "trade-message",
      friendlyError(error, "注文に失敗しました。")
    );

  } finally {
    isTrading = false;

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
    return "メールアドレスの確認が必要です。";
  }

  if (message.includes("ポイントが不足")) {
    return "ポイントが不足しています。";
  }

  if (
    message.includes("保有株数が不足") ||
    message.includes("売却する株数が保有株数を超えています")
  ) {
    return "売却できませんでした。保有株数と選択した銘柄を確認してください。";
  }

  if (message.includes("銘柄が見つかりません")) {
    return "銘柄が見つかりません。画面を更新してください。";
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

  if (message.includes("Failed to fetch")) {
    return "Supabaseに接続できません。URLとネットワークを確認してください。";
  }

  return message || fallback;
}

/* =====================================================
   起動
   ===================================================== */

document.addEventListener(
  "DOMContentLoaded",
  initializeApp
);
```
