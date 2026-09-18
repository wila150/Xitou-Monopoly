const VERIFY_TYPES = [
  { value: "keyword", label: "密語（隊伍輸入文字）" },
  { value: "photo", label: "照片（小編/關主通過確認）" },
  { value: "video", label: "影片（小編/關主通過確認）" },
  { value: "referee", label: "關主直接喊過（不接受隊伍輸入）" },
];

// 使用者可控的文字（LINE 顯示名稱、緊急聯絡說明）放進 innerHTML 前一律先跳脫，避免有人把名稱取成 HTML 標籤
const escapeHtml = (t) =>
  String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts) {
  const res = await fetch(`/admin${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) {
    window.location.href = "/admin/login";
    throw new Error("未登入");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `發生錯誤（${res.status}）`);
  return data;
}

function showMsg(el, text, isErr) {
  el.textContent = text;
  el.className = "msg " + (isErr ? "err" : "ok");
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 4000);
}

// ---- 分頁切換 ----
function switchTab(tab) {
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if (!btn) return;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById(`panel-${tab}`).classList.add("active");
  if (tab === "progress") { loadProgress(); loadBroadcastScope(); }
  if (tab === "referees") loadReferees();
  if (tab === "leaders") loadTeamLeaders();
  if (tab === "broadcasters") loadBroadcasters();
  if (tab === "emergencies") loadEmergencies();
  if (tab === "submissions") loadSubmissions();
  if (tab === "bonus-log") loadBonusLog();
  if (tab === "welcome") loadWelcomeMessage();
}
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

document.getElementById("logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/admin/login";
});

// ---- 關卡設定 ----
const cpMsg = document.getElementById("cp-msg");
const cpList = document.getElementById("cp-list");

const IMAGE_CATEGORY_LABELS = { "site-photos": "現場照片", "map-images": "地圖位置圖" };

function imageChipsHtml(files, category) {
  const chips = (files || [])
    .map(
      (f) =>
        `<span class="chip"><a href="/maps/${f}" target="_blank">${f}</a><button data-action="del-image" data-category="${category}" data-file="${f}">✕</button></span>`
    )
    .join("");
  return chips || "（尚未上傳）";
}

function cpCardHtml(cp) {
  const options = VERIFY_TYPES
    .map((t) => `<option value="${t.value}" ${cp.verifyType === t.value ? "selected" : ""}>${t.label}</option>`)
    .join("");
  return `
    <details class="cp-card" data-id="${cp.id}">
      <summary>${cp.id}｜${cp.name}</summary>
      <div class="field"><label>關卡代號 (id)</label><input value="${cp.id}" disabled /></div>
      <div class="field"><label>關卡名稱</label><input class="f-name" value="${cp.name || ""}" /></div>
      <div class="field"><label>地點</label><input class="f-location" value="${cp.location || ""}" /></div>
      <div class="field"><label>關卡內容說明</label><textarea class="f-content">${cp.content || ""}</textarea></div>
      <div class="field"><label>計分方式說明</label><input class="f-scoring" value="${cp.scoringMethod || ""}" /></div>
      <div class="field"><label>通關方式</label><select class="f-verify">${options}</select></div>
      <div class="field"><label>排序（數字越小越前面）</label><input class="f-sort" type="number" value="${cp.sortOrder ?? 0}" /></div>
      <div class="field">
        <label>現場照片（這關實際長什麼樣子／任務參考照）</label>
        <div class="map-files" data-category="site-photos">${imageChipsHtml(cp.sitePhotos, "site-photos")}</div>
        <input type="file" class="f-image" data-category="site-photos" accept="image/*" style="margin-top:6px" />
      </div>
      <div class="field">
        <label>地圖位置圖（怎麼走到這關）</label>
        <div class="map-files" data-category="map-images">${imageChipsHtml(cp.mapImages, "map-images")}</div>
        <input type="file" class="f-image" data-category="map-images" accept="image/*" style="margin-top:6px" />
      </div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button class="btn" data-action="save">💾 儲存</button>
        <button class="btn danger" data-action="delete">🗑 刪除這關</button>
      </div>
    </details>
  `;
}

async function loadCheckpoints() {
  const cps = await api("/api/checkpoints");
  cpList.innerHTML = cps.map(cpCardHtml).join("");
}

cpList.addEventListener("click", async (e) => {
  const card = e.target.closest(".cp-card");
  if (!card) return;
  const id = card.dataset.id;

  if (e.target.dataset.action === "save") {
    e.preventDefault();
    try {
      const body = {
        name: card.querySelector(".f-name").value.trim(),
        location: card.querySelector(".f-location").value.trim(),
        content: card.querySelector(".f-content").value.trim(),
        scoringMethod: card.querySelector(".f-scoring").value.trim(),
        verifyType: card.querySelector(".f-verify").value,
        sortOrder: Number(card.querySelector(".f-sort").value) || 0,
      };
      await api(`/api/checkpoints/${id}`, { method: "PUT", body: JSON.stringify(body) });
      showMsg(cpMsg, `已儲存「${id}」`, false);
      await loadCheckpoints();
    } catch (err) {
      showMsg(cpMsg, err.message, true);
    }
  }

  if (e.target.dataset.action === "delete") {
    e.preventDefault();
    if (!confirm(`確定要刪除關卡「${id}」嗎？如果有組別的路線用到這關，會導致該組路線失效，請先確認。`)) return;
    try {
      await api(`/api/checkpoints/${id}`, { method: "DELETE" });
      showMsg(cpMsg, `已刪除「${id}」`, false);
      await loadCheckpoints();
    } catch (err) {
      showMsg(cpMsg, err.message, true);
    }
  }

  if (e.target.dataset.action === "del-image") {
    e.preventDefault();
    const file = e.target.dataset.file;
    const category = e.target.dataset.category;
    try {
      await api(`/api/checkpoints/${id}/${category}/${encodeURIComponent(file)}`, { method: "DELETE" });
      showMsg(cpMsg, `已移除${IMAGE_CATEGORY_LABELS[category]}`, false);
      await loadCheckpoints();
    } catch (err) {
      showMsg(cpMsg, err.message, true);
    }
  }
});

cpList.addEventListener("change", async (e) => {
  if (!e.target.classList.contains("f-image")) return;
  const card = e.target.closest(".cp-card");
  const id = card.dataset.id;
  const category = e.target.dataset.category;
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append("image", file);
  try {
    const res = await fetch(`/admin/api/checkpoints/${id}/${category}`, { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "上傳失敗");
    showMsg(cpMsg, `${IMAGE_CATEGORY_LABELS[category]}已上傳`, false);
    await loadCheckpoints();
  } catch (err) {
    showMsg(cpMsg, err.message, true);
  }
});

document.getElementById("add-cp").addEventListener("click", async () => {
  const idInput = document.getElementById("new-cp-id");
  const id = idInput.value.trim();
  if (!id) return showMsg(cpMsg, "請輸入新關卡代號", true);
  try {
    await api(`/api/checkpoints/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: `未命名關卡 ${id}`,
        location: "請填寫地點",
        content: "請填寫關卡內容說明",
        scoringMethod: "請填寫計分方式",
        verifyType: "keyword",
        sortOrder: 999,
      }),
    });
    idInput.value = "";
    showMsg(cpMsg, `已新增關卡「${id}」，請展開編輯詳細內容`, false);
    await loadCheckpoints();
  } catch (err) {
    showMsg(cpMsg, err.message, true);
  }
});

// ---- 組別路線 ----
const routeMsg = document.getElementById("route-msg");
const routeList = document.getElementById("route-list");
let allCheckpointIds = [];

function routeStepHtml(step, idx) {
  const options = allCheckpointIds
    .map((id) => `<option value="${id}" ${step.checkpointId === id ? "selected" : ""}>${id}</option>`)
    .join("");
  return `
    <div class="route-step" data-idx="${idx}">
      <span>${idx + 1}.</span>
      <select class="s-checkpoint">${options}</select>
      <input class="s-keyword" placeholder="密語（用｜分隔多個答案，非密語關可留空）" value="${step.keyword || ""}" />
      <button class="btn secondary" data-action="remove-step">移除</button>
    </div>
  `;
}

function routeCardHtml(groupNo, route) {
  return `
    <div class="route-card" data-group="${groupNo}">
      <strong>第 ${groupNo} 組</strong>
      <div class="steps">${route.map(routeStepHtml).join("")}</div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button class="btn secondary" data-action="add-step">＋ 新增關卡步驟</button>
        <button class="btn" data-action="save-route">💾 儲存路線</button>
        <button class="btn danger" data-action="delete-group">🗑 刪除整組</button>
      </div>
    </div>
  `;
}

async function loadRoutes() {
  const { routes, checkpointIds } = await api("/api/routes");
  allCheckpointIds = checkpointIds;
  routeList.innerHTML = Object.entries(routes)
    .map(([groupNo, route]) => routeCardHtml(groupNo, route))
    .join("");
}

function readRouteFromCard(card) {
  return Array.from(card.querySelectorAll(".route-step")).map((stepEl) => ({
    checkpointId: stepEl.querySelector(".s-checkpoint").value,
    keyword: stepEl.querySelector(".s-keyword").value.trim() || null,
  }));
}

routeList.addEventListener("click", async (e) => {
  const card = e.target.closest(".route-card");
  if (!card) return;
  const groupNo = card.dataset.group;

  if (e.target.dataset.action === "add-step") {
    e.preventDefault();
    const stepsDiv = card.querySelector(".steps");
    const idx = stepsDiv.children.length;
    stepsDiv.insertAdjacentHTML("beforeend", routeStepHtml({ checkpointId: allCheckpointIds[0], keyword: "" }, idx));
  }

  if (e.target.dataset.action === "remove-step") {
    e.preventDefault();
    e.target.closest(".route-step").remove();
  }

  if (e.target.dataset.action === "save-route") {
    e.preventDefault();
    try {
      const route = readRouteFromCard(card);
      await api(`/api/routes/${groupNo}`, { method: "PUT", body: JSON.stringify({ route }) });
      showMsg(routeMsg, `已儲存第 ${groupNo} 組路線`, false);
      await loadRoutes();
    } catch (err) {
      showMsg(routeMsg, err.message, true);
    }
  }

  if (e.target.dataset.action === "delete-group") {
    e.preventDefault();
    if (!confirm(`確定要刪除第 ${groupNo} 組的路線設定嗎？`)) return;
    try {
      await api(`/api/routes/${groupNo}`, { method: "DELETE" });
      showMsg(routeMsg, `已刪除第 ${groupNo} 組`, false);
      await loadRoutes();
    } catch (err) {
      showMsg(routeMsg, err.message, true);
    }
  }
});

document.getElementById("add-group").addEventListener("click", async () => {
  const input = document.getElementById("new-group-no");
  const groupNo = Number(input.value);
  if (!groupNo || groupNo <= 0) return showMsg(routeMsg, "請輸入正整數組別編號", true);
  if (!allCheckpointIds.length) return showMsg(routeMsg, "請先到「關卡設定」建立至少一個關卡", true);
  try {
    await api(`/api/routes/${groupNo}`, {
      method: "PUT",
      body: JSON.stringify({ route: [{ checkpointId: allCheckpointIds[0], keyword: null }] }),
    });
    input.value = "";
    showMsg(routeMsg, `已新增第 ${groupNo} 組，請編輯完整路線`, false);
    await loadRoutes();
  } catch (err) {
    showMsg(routeMsg, err.message, true);
  }
});

// ---- 即時進度 ----
async function loadProgress() {
  // 自動更新會重畫整張表，先記下勾選的組別，重畫後還原，不然勾到一半就被清掉
  const checkedBefore = new Set(
    [...document.querySelectorAll(".depart-check:checked, .finish-check:checked")].map((c) => c.value)
  );
  const rows = await api("/api/progress");
  document.getElementById("progress-body").innerHTML = rows
    .map((r) => {
      const statusLabel = {
        NOT_CHECKED_IN: "尚未報到",
        CHECKED_IN: "已報到／待出發",
        IN_PROGRESS: "闖關中",
        FINISHED: "已終點確認",
      }[r.status] || r.status;
      const bonus = r.bonusPoints || 0;
      const canDepart = r.status === "CHECKED_IN";
      const inProgress = r.status === "IN_PROGRESS";
      const finished = r.status === "FINISHED";
      const canApprove = inProgress && !!r.currentCheckpointId;
      const canRevert = (inProgress && r.currentIndex > 0) || finished;
      const currentCp = r.currentCheckpointId
        ? `${escapeHtml(r.currentCheckpointId)} ${escapeHtml(r.currentCheckpointName)}`
        : inProgress ? "已走完全部關卡" : "-";
      const checkClass = canDepart ? "depart-check" : "finish-check";
      const checked = checkedBefore.has(String(r.groupNo)) ? "checked" : "";
      return `
        <tr>
          <td>${canDepart || inProgress ? `<input type="checkbox" class="${checkClass}" value="${r.groupNo}" ${checked} />` : ""}</td>
          <td>第 ${r.groupNo} 組</td>
          <td><span class="status-tag status-${r.status}">${statusLabel}</span></td>
          <td>${currentCp}</td>
          <td>${r.startTime ? formatClock(r.startTime) : "-"}</td>
          <td>${r.finishTime ? formatClock(r.finishTime) : "-"}</td>
          <td>${r.currentIndex != null ? `${r.currentIndex}/${r.totalCheckpoints}` : "-"}</td>
          <td>${r.elapsed || "-"}</td>
          <td>${r.isLate === true ? "⚠️ 逾時" : r.isLate === false ? "準時" : "-"}</td>
          <td>${bonus !== 0 ? (bonus > 0 ? `+${bonus}` : bonus) : "-"}</td>
          <td style="white-space:nowrap;">
            ${canDepart ? `<button class="btn depart-one" data-group="${r.groupNo}">🚩 出發</button>` : ""}
            ${inProgress ? `<button class="btn finish-one" data-group="${r.groupNo}">🏁 到站</button>` : ""}
            ${canApprove ? `<button class="btn team-op" data-op="approve" data-group="${r.groupNo}">✅ 通過</button>` : ""}
            ${canRevert ? `<button class="btn secondary team-op" data-op="revert" data-group="${r.groupNo}">↩ 退回</button>` : ""}
            ${finished ? `<button class="btn secondary team-op" data-op="cancel-finish" data-group="${r.groupNo}">取消到站</button>` : ""}
          </td>
        </tr>
      `;
    })
    .join("");
  document.querySelectorAll(".depart-one").forEach((btn) => {
    btn.addEventListener("click", () => departGroups([Number(btn.dataset.group)]));
  });
  document.querySelectorAll(".finish-one").forEach((btn) => {
    btn.addEventListener("click", () => finishGroups([Number(btn.dataset.group)]));
  });
  document.querySelectorAll(".team-op").forEach((btn) => {
    btn.addEventListener("click", () => teamOperation(Number(btn.dataset.group), btn.dataset.op));
  });
}
document.getElementById("refresh-progress").addEventListener("click", loadProgress);

// 時分秒＋日期（台北時間），出發時間要看到秒才對得上逾時判斷
function formatClock(iso) {
  return new Date(iso).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
}

// ---- 後台出發／到站 ----
// 兩者流程一樣：確認 → 呼叫 API（可帶補登時間）→ 彙整每組結果。差別只在 API 路徑、時間欄位與文字。
let groupActionRunning = false;
async function runGroupAction({ groupNos, path, timeInputId, timeField, verb, warning }) {
  if (groupActionRunning) return;
  if (groupNos.length === 0) {
    showMsg(progressMsg, `請先勾選要${verb}的組別。`, true);
    return;
  }
  const timeInput = document.getElementById(timeInputId).value;
  const iso = timeInput ? new Date(timeInput).toISOString() : null;
  const when = timeInput ? `${verb}時間 ${timeInput.replace("T", " ")}` : `${verb}時間：現在`;
  const names = groupNos.map((g) => `第 ${g} 組`).join("、");
  if (!confirm(`確定讓 ${names} ${verb}嗎？\n${when}\n\n${warning}`)) return;
  groupActionRunning = true;
  try {
    const { results } = await api(path, {
      method: "POST",
      body: JSON.stringify({ groupNos, [timeField]: iso }),
    });
    const ok = results.filter((r) => r.done).map((r) => r.groupNo);
    const skipped = results.filter((r) => !r.done).map((r) => `第 ${r.groupNo} 組：${r.message}`);
    const notifyFailed = results.filter((r) => r.notifyFailed).map((r) => r.groupNo);
    let text = ok.length ? `已${verb}：${ok.map((g) => `第 ${g} 組`).join("、")}。` : "";
    if (skipped.length) text += ` 未${verb}：${skipped.join("；")}`;
    if (notifyFailed.length) text += ` ⚠️ 第 ${notifyFailed.join("、")} 組已記錄，但 LINE 通知沒送出，請到 LINE 手動通知。`;
    showMsg(progressMsg, text.trim(), skipped.length > 0 || notifyFailed.length > 0);
    await loadProgress();
  } catch (err) {
    showMsg(progressMsg, err.message, true);
  } finally {
    groupActionRunning = false;
  }
}

const departGroups = (groupNos) =>
  runGroupAction({
    groupNos,
    path: "/api/depart",
    timeInputId: "depart-time",
    timeField: "startedAt",
    verb: "出發",
    warning: "出發後會開始計時並推播第一關給隊伍，無法取消。",
  });
const finishGroups = (groupNos) =>
  runGroupAction({
    groupNos,
    path: "/api/finish",
    timeInputId: "finish-time",
    timeField: "finishedAt",
    verb: "到站",
    warning: "到站後會停止計時並依出發後是否超過 2 小時標註準時／逾時；按錯可在 LINE 輸入「取消到站 X組」更正。",
  });

const checkedGroups = (selector) => [...document.querySelectorAll(selector + ":checked")].map((c) => Number(c.value));
document.getElementById("depart-selected").addEventListener("click", () => departGroups(checkedGroups(".depart-check")));
document.getElementById("finish-selected").addEventListener("click", () => finishGroups(checkedGroups(".finish-check")));

// 單組操作：通過／退回／取消到站，跟 LINE 指令效果相同（見 src/admin/router.js 的 teamAction）
const TEAM_OPERATIONS = {
  approve: { label: "通過目前這一關", warning: "會放行該組目前這一關並推播下一關給隊伍，等同 LINE 輸入「通過 X組」。" },
  revert: { label: "退回一關", warning: "完成關卡數 -1，該關重新視為未完成；已到站的組別會一併取消終點確認、清掉結束時間與逾時。" },
  "cancel-finish": { label: "取消到站", warning: "只取消終點確認，完成關卡數不變，該組恢復闖關中、計時繼續累加。" },
};
async function teamOperation(groupNo, op) {
  if (groupActionRunning) return;
  const { label, warning } = TEAM_OPERATIONS[op];
  if (!confirm(`確定要對第 ${groupNo} 組執行「${label}」嗎？\n\n${warning}`)) return;
  groupActionRunning = true;
  try {
    const res = await api(`/api/teams/${groupNo}/${op}`, { method: "POST" });
    const note = res.notifyFailed ? " ⚠️ 已記錄，但 LINE 通知沒送出，請到 LINE 手動通知。" : "";
    showMsg(progressMsg, res.message + note, !res.done || res.notifyFailed);
    await loadProgress();
  } catch (err) {
    showMsg(progressMsg, err.message, true);
  } finally {
    groupActionRunning = false;
  }
}

// 即時進度停在畫面上時每 10 秒自動更新（操作進行中或視窗在背景時不更新）
setInterval(() => {
  if (document.hidden || groupActionRunning) return;
  if (!document.getElementById("panel-progress").classList.contains("active")) return;
  loadProgress().catch(() => {});
}, 10000);

const progressMsg = document.getElementById("progress-msg");
document.getElementById("reset-game").addEventListener("click", async () => {
  if (!confirm("⚠️ 這會清空所有隊伍的報到、進度與紀錄，且無法復原，確定要重置整場遊戲嗎？")) return;
  const typed = prompt('請輸入「確認重置」以繼續：');
  if (typed !== "確認重置") {
    showMsg(progressMsg, "輸入不符，已取消重置。", true);
    return;
  }
  try {
    await api("/api/reset-game", { method: "POST", body: JSON.stringify({ confirm: true }) });
    showMsg(progressMsg, "已重置整場遊戲。", false);
    await loadProgress();
  } catch (err) {
    showMsg(progressMsg, err.message, true);
  }
});

async function loadBroadcastScope() {
  const { scope } = await api("/api/broadcast-scope");
  document.getElementById("broadcast-scope").value = scope;
}
document.getElementById("broadcast-scope").addEventListener("change", async (e) => {
  try {
    await api("/api/broadcast-scope", {
      method: "PUT",
      body: JSON.stringify({ scope: e.target.value }),
    });
    showMsg(progressMsg, "已更新關卡公告推播對象。", false);
  } catch (err) {
    showMsg(progressMsg, err.message, true);
  }
});

// ---- 關主名單 ----
// 傳過訊息給官方帳號的人 → 下拉選單選項。已在隊伍裡的人不能指定（跟自助登記同樣規則），並標出現有身分方便辨識
function lineUserLabel(u) {
  const badges = [
    u.teamLabel,
    u.refereeCheckpointId ? `${u.refereeCheckpointId} 關主` : null,
    u.isBroadcaster ? "總領隊" : null,
    u.isAdmin ? "小編" : null,
  ].filter(Boolean);
  return `${u.displayName || "（未取得名稱）"} …${u.userIdSuffix}${badges.length ? `［${badges.join("、")}］` : ""}`;
}

async function fillUserSelect(selectId) {
  const select = document.getElementById(selectId);
  const previous = select.value;
  const users = await api("/api/line-users");
  select.innerHTML =
    `<option value="">— 選擇人員（${users.length} 位）—</option>` +
    users
      .map((u) => `<option value="${escapeHtml(u.userId)}" ${u.isTeamMember ? "disabled" : ""}>${escapeHtml(lineUserLabel(u))}</option>`)
      .join("");
  if (previous) select.value = previous;
}

let checkpointOptionsHtml = "";
async function fillCheckpointSelect() {
  const cps = await api("/api/checkpoints");
  checkpointOptionsHtml = cps.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.id)} ${escapeHtml(c.name)}</option>`).join("");
  document.getElementById("assign-referee-cp").innerHTML = checkpointOptionsHtml;
}

const refereesMsg = document.getElementById("referees-msg");
async function loadReferees() {
  const rows = await api("/api/referees");
  document.getElementById("referees-body").innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.checkpointId)}</td>
        <td>${escapeHtml(r.displayName || "-")}</td>
        <td>...${escapeHtml(r.userIdSuffix)}</td>
        <td>${new Date(r.registeredAt).toLocaleString("zh-TW")}</td>
        <td><button class="btn danger remove-referee" data-user="${escapeHtml(r.userId)}">移除</button></td>
      </tr>`
    )
    .join("") || `<tr><td colspan="5" style="color:#888;">目前沒有人登記為關主</td></tr>`;
  document.querySelectorAll(".remove-referee").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("確定取消這位關主的身分嗎？對方會收到 LINE 通知。")) return;
      try {
        const res = await api(`/api/referees/${encodeURIComponent(btn.dataset.user)}`, { method: "DELETE" });
        showMsg(refereesMsg, res.message + (res.notifyFailed ? "（LINE 通知沒送出）" : ""), res.notifyFailed);
        await loadReferees();
      } catch (err) {
        showMsg(refereesMsg, err.message, true);
      }
    });
  });
  await Promise.all([fillUserSelect("assign-referee-user"), fillCheckpointSelect()]).catch(() => {});
}
document.getElementById("refresh-referees").addEventListener("click", loadReferees);
document.getElementById("assign-referee").addEventListener("click", async () => {
  const userId = document.getElementById("assign-referee-user").value;
  const checkpointId = document.getElementById("assign-referee-cp").value;
  if (!userId) return showMsg(refereesMsg, "請先選擇要指定的人員。", true);
  try {
    const res = await api("/api/referees", { method: "POST", body: JSON.stringify({ userId, checkpointId }) });
    showMsg(refereesMsg, res.message + (res.notifyFailed ? "（⚠️ LINE 通知沒送出，請當面告知對方）" : "，已通知對方。"), res.notifyFailed);
    await loadReferees();
  } catch (err) {
    showMsg(refereesMsg, err.message, true);
  }
});

// ---- 小隊長名單 ----
const STATUS_LABELS = {
  NOT_CHECKED_IN: "尚未報到",
  CHECKED_IN: "已報到／待出發",
  IN_PROGRESS: "闖關中",
  FINISHED: "已終點確認",
};

async function loadTeamLeaders() {
  const rows = await api("/api/team-leaders");
  document.getElementById("leaders-body").innerHTML = rows
    .map(
      (r) => `
        <tr>
          <td>第 ${r.groupNo} 組</td>
          <td>${escapeHtml(r.displayName || "-")}</td>
          <td>...${r.userIdSuffix}</td>
          <td><span class="status-tag status-${r.status}">${STATUS_LABELS[r.status] || r.status}</span></td>
          <td>${r.joinedAt ? new Date(r.joinedAt).toLocaleString("zh-TW") : "-"}</td>
        </tr>
      `
    )
    .join("");
}
document.getElementById("refresh-leaders").addEventListener("click", loadTeamLeaders);

// ---- 總領隊名單 ----
const broadcastersMsg = document.getElementById("broadcasters-msg");
async function loadBroadcasters() {
  const rows = await api("/api/broadcasters");
  document.getElementById("broadcasters-body").innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.displayName || "-")}</td>
        <td>...${escapeHtml(r.userIdSuffix)}</td>
        <td>${new Date(r.registeredAt).toLocaleString("zh-TW")}</td>
        <td><button class="btn danger remove-broadcaster" data-user="${escapeHtml(r.userId)}">移除</button></td>
      </tr>`
    )
    .join("") || `<tr><td colspan="4" style="color:#888;">目前沒有人登記為總領隊</td></tr>`;
  document.querySelectorAll(".remove-broadcaster").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("確定取消這位總領隊的身分嗎？對方會收到 LINE 通知。")) return;
      try {
        const res = await api(`/api/broadcasters/${encodeURIComponent(btn.dataset.user)}`, { method: "DELETE" });
        showMsg(broadcastersMsg, res.message + (res.notifyFailed ? "（LINE 通知沒送出）" : ""), res.notifyFailed);
        await loadBroadcasters();
      } catch (err) {
        showMsg(broadcastersMsg, err.message, true);
      }
    });
  });
  await fillUserSelect("assign-broadcaster-user").catch(() => {});
}
document.getElementById("refresh-broadcasters").addEventListener("click", loadBroadcasters);
document.getElementById("assign-broadcaster").addEventListener("click", async () => {
  const userId = document.getElementById("assign-broadcaster-user").value;
  if (!userId) return showMsg(broadcastersMsg, "請先選擇要指定的人員。", true);
  try {
    const res = await api("/api/broadcasters", { method: "POST", body: JSON.stringify({ userId }) });
    showMsg(broadcastersMsg, res.message + (res.notifyFailed ? "（⚠️ LINE 通知沒送出，請當面告知對方）" : "，已通知對方。"), res.notifyFailed);
    await loadBroadcasters();
  } catch (err) {
    showMsg(broadcastersMsg, err.message, true);
  }
});

// ---- 緊急聯絡 ----
const emergenciesMsg = document.getElementById("emergencies-msg");

function emergencyCardHtml(r) {
  const open = r.status === "OPEN";
  const who = r.displayName ? `${r.displayName}（${r.identityLabel}）` : r.identityLabel;
  return `
    <div class="cp-card" data-id="${r.id}" style="${open ? "border-left:5px solid #c0392b;" : "opacity:.65;"}">
      <strong>${open ? "🚨" : "✅"} #${r.id}｜${escapeHtml(who)}</strong>
      ${r.checkpointLabel ? `<p style="margin:6px 0 0;">📍 目前關卡：${escapeHtml(r.checkpointLabel)}</p>` : ""}
      <p style="margin:6px 0 0;">💬 ${r.detail ? escapeHtml(r.detail) : `<span style="color:#888;">（尚未說明，請儘快聯繫對方確認狀況）</span>`}</p>
      <p style="font-size:12px;color:#888;margin:6px 0 0;">
        🆔 ...${escapeHtml(r.userIdSuffix)}　送出：${new Date(r.createdAt).toLocaleString("zh-TW")}
        ${open ? "" : `　處理：${r.handledAt ? new Date(r.handledAt).toLocaleString("zh-TW") : "-"}`}
      </p>
      ${open ? `<div class="toolbar" style="margin-top:10px;"><button class="btn handle-emergency" data-id="${r.id}">✅ 已處理（通知回報者）</button></div>` : ""}
    </div>
  `;
}

let lastEmergencySnapshot = "";
async function loadEmergencies({ silent = false } = {}) {
  const rows = await api("/api/emergencies");
  updateEmergencyBadge(rows.filter((r) => r.status === "OPEN").length);
  const snapshot = JSON.stringify(rows.map((r) => [r.id, r.status, r.detail, r.lastAlertedAt]));
  if (silent && snapshot === lastEmergencySnapshot) return;
  lastEmergencySnapshot = snapshot;
  const list = document.getElementById("emergencies-list");
  if (rows.length === 0) {
    list.innerHTML = `<p style="color:#888;font-size:13px;">目前沒有任何緊急聯絡 👍</p>`;
    return;
  }
  list.innerHTML = rows.map(emergencyCardHtml).join("");
  list.querySelectorAll(".handle-emergency").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const res = await api(`/api/emergencies/${btn.dataset.id}/handle`, { method: "POST" });
        showMsg(emergenciesMsg, res.message || "已標記為處理中，並通知回報者。", false);
        await loadEmergencies();
      } catch (err) {
        btn.disabled = false;
        showMsg(emergenciesMsg, err.message, true);
      }
    });
  });
}
document.getElementById("refresh-emergencies").addEventListener("click", () => loadEmergencies());

// 緊急聯絡比審核急：不管停在哪個分頁都每 5 秒更新一次數量徽章（在這個分頁時連內容一起更新）
setInterval(() => {
  if (document.hidden) return;
  const onTab = document.getElementById("panel-emergencies").classList.contains("active");
  loadEmergencies({ silent: onTab }).catch(() => {});
}, 5000);

// ---- 照片／影片審核佇列 ----
const submissionsMsg = document.getElementById("submissions-msg");
const BASE_TITLE = document.title;
let approvingIds = new Set();

// 分頁標籤與瀏覽器標題顯示待審核數量，小編不用一直切到這個分頁才知道有新的
let pendingSubmissionCount = 0;
let openEmergencyCount = 0;

function refreshTitleBadge() {
  const prefix =
    (openEmergencyCount > 0 ? `🚨${openEmergencyCount} ` : "") +
    (pendingSubmissionCount > 0 ? `(${pendingSubmissionCount}) ` : "");
  document.title = prefix + BASE_TITLE;
}

function updatePendingBadge(count) {
  pendingSubmissionCount = count;
  const tab = document.querySelector('.tab-btn[data-tab="submissions"]');
  tab.textContent = count > 0 ? `照片／影片審核 (${count})` : "照片／影片審核";
  refreshTitleBadge();
}

function updateEmergencyBadge(count) {
  openEmergencyCount = count;
  const tab = document.querySelector('.tab-btn[data-tab="emergencies"]');
  tab.textContent = count > 0 ? `🚨 緊急聯絡 (${count})` : "🚨 緊急聯絡";
  tab.classList.toggle("alert", count > 0);
  refreshTitleBadge();
}

function submissionCardHtml(r) {
  const mediaUrl = `/admin/api/submissions/${r.id}/media`;
  const mediaEl =
    r.mediaType === "video"
      ? `<video src="${mediaUrl}" controls preload="metadata" playsinline style="max-width:100%;max-height:360px;border-radius:6px;"></video>`
      : `<a href="${mediaUrl}" target="_blank" rel="noopener"><img src="${mediaUrl}" alt="第 ${r.groupNo} 組上傳的照片" style="max-width:100%;max-height:360px;border-radius:6px;" /></a>`;
  return `
    <div class="cp-card" data-id="${r.id}">
      <strong>第 ${r.groupNo} 組｜${r.checkpointName}（${r.checkpointId}）</strong>
      <p style="font-size:12px;color:#888;margin:4px 0 10px;">上傳時間：${new Date(r.submittedAt).toLocaleString("zh-TW")}</p>
      ${mediaEl}
      <p class="media-error" style="display:none;font-size:12px;color:#c0392b;">
        預覽載入失敗。<span class="media-error-reason">正在檢查原因…</span>
        <a href="${mediaUrl}" download>⬇ 下載檔案</a>｜<a href="${mediaUrl}" target="_blank" rel="noopener">新分頁開啟</a>｜或到 LINE 聊天記錄確認。
      </p>
      <div class="toolbar" style="margin-top:10px;">
        <button class="btn approve-submission" data-id="${r.id}">✅ 通過</button>
        <button class="btn danger reject-submission" data-id="${r.id}">🗑 移除</button>
      </div>
    </div>
  `;
}

// 預覽載入失敗時，只抓第一個 byte 問伺服器發生什麼事，把原因顯示給小編（不用開開發者工具）
async function diagnoseMediaFailure(url, isVideo) {
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-0" } });
    if (res.status === 401) {
      window.location.href = "/admin/login";
      return "登入已過期，正在跳轉到登入頁…";
    }
    if (res.status === 404 || res.status === 416) {
      const data = await res.json().catch(() => ({}));
      return data.error || "檔案是空的或已被處理過，請到 LINE 聊天記錄確認，並請隊伍重傳。";
    }
    if (res.ok) {
      const type = res.headers.get("content-type") || "未知格式";
      const range = res.headers.get("content-range");
      const size = range ? Number(range.split("/")[1]) : Number(res.headers.get("content-length"));
      const sizeText = size ? `${(size / 1024 / 1024).toFixed(1)} MB` : "大小未知";
      if (type.includes("heic")) return `檔案存在（${type}，${sizeText}）但這是 iPhone 原始照片格式，瀏覽器通常無法顯示，請下載後檢視。`;
      return `檔案存在（${type}，${sizeText}）但瀏覽器無法播放／顯示${isVideo ? "，可能是 iPhone 的 HEVC 編碼影片，Chrome 需要硬體支援才能播" : ""}，請下載後用播放器開啟，或改用 Safari。`;
    }
    return `伺服器回應 HTTP ${res.status}。`;
  } catch (err) {
    return "連線失敗，請確認網路後按「重新整理」。";
  }
}

function bindSubmissionCards(list) {
  list.querySelectorAll("img, video").forEach((el) => {
    el.addEventListener("error", () => {
      el.style.display = "none";
      const card = el.closest(".cp-card");
      card.querySelector(".media-error").style.display = "block";
      diagnoseMediaFailure(el.currentSrc || el.src, el.tagName === "VIDEO").then((reason) => {
        card.querySelector(".media-error-reason").textContent = reason;
      });
    });
  });
  list.querySelectorAll(".approve-submission").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (approvingIds.has(id)) return;
      approvingIds.add(id);
      btn.disabled = true;
      try {
        await api(`/api/submissions/${id}/approve`, { method: "POST" });
        showMsg(submissionsMsg, "已通過，訊息已推播給隊伍。", false);
        // 該組所有待審核紀錄都已清空，重新載入一次以移除同組其他卡片
        await loadSubmissions();
      } catch (err) {
        btn.disabled = false;
        showMsg(submissionsMsg, err.message, true);
      } finally {
        approvingIds.delete(id);
      }
    });
  });
  list.querySelectorAll(".reject-submission").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("只會移除這筆待審核紀錄，不會讓隊伍過關，確定嗎？")) return;
      try {
        await api(`/api/submissions/${btn.dataset.id}`, { method: "DELETE" });
        showMsg(submissionsMsg, "已移除。", false);
        await loadSubmissions();
      } catch (err) {
        showMsg(submissionsMsg, err.message, true);
      }
    });
  });
}

let lastSubmissionIds = "";
async function loadSubmissions({ silent = false } = {}) {
  const rows = await api("/api/submissions");
  updatePendingBadge(rows.length);
  const ids = rows.map((r) => r.id).join(",");
  // 自動更新時內容沒變就不重畫，避免影片播放到一半被打斷
  if (silent && ids === lastSubmissionIds) return;
  lastSubmissionIds = ids;
  const list = document.getElementById("submissions-list");
  if (rows.length === 0) {
    list.innerHTML = `<p style="color:#888;font-size:13px;">目前沒有待審核的照片／影片。</p>`;
    return;
  }
  list.innerHTML = rows.map(submissionCardHtml).join("");
  bindSubmissionCards(list);
}
document.getElementById("refresh-submissions").addEventListener("click", () => loadSubmissions());

// 停在審核分頁時每 8 秒自動更新；不在這個分頁時每 20 秒只更新數量徽章
setInterval(() => {
  if (document.hidden) return;
  const onSubmissionsTab = document.getElementById("panel-submissions").classList.contains("active");
  if (onSubmissionsTab) loadSubmissions({ silent: true }).catch(() => {});
}, 8000);
setInterval(() => {
  if (document.hidden) return;
  if (document.getElementById("panel-submissions").classList.contains("active")) return;
  api("/api/submissions").then((rows) => updatePendingBadge(rows.length)).catch(() => {});
}, 20000);

// ---- 加分紀錄 ----
async function loadBonusLog() {
  const rows = await api("/api/bonus-log");
  document.getElementById("bonus-log-body").innerHTML = rows
    .map((r) => {
      const pointsText = r.points > 0 ? `+${r.points}` : `${r.points}`;
      return `
        <tr>
          <td>第 ${r.groupNo} 組</td>
          <td>${pointsText}</td>
          <td>${r.reason || "-"}</td>
          <td>...${r.awardedBySuffix}</td>
          <td>${new Date(r.awardedAt).toLocaleString("zh-TW")}</td>
        </tr>
      `;
    })
    .join("") || `<tr><td colspan="5" style="color:#888;">目前沒有任何加分紀錄</td></tr>`;
}
document.getElementById("refresh-bonus-log").addEventListener("click", loadBonusLog);

// ---- 加好友歡迎詞 ----
const welcomeMsg = document.getElementById("welcome-msg");
async function loadWelcomeMessage() {
  const { message } = await api("/api/welcome-message");
  document.getElementById("welcome-text").value = message;
}
document.getElementById("save-welcome").addEventListener("click", async () => {
  try {
    const message = document.getElementById("welcome-text").value;
    await api("/api/welcome-message", { method: "PUT", body: JSON.stringify({ message }) });
    showMsg(welcomeMsg, "已儲存歡迎訊息", false);
  } catch (err) {
    showMsg(welcomeMsg, err.message, true);
  }
});

// ---- 初始載入 ----
loadCheckpoints().catch((err) => showMsg(cpMsg, err.message, true));
loadRoutes().catch((err) => showMsg(routeMsg, err.message, true));

// LINE 通知附的連結是 /admin#submissions，直接打開審核分頁；一般進來也先載入一次待審核數量徽章
if (location.hash === "#submissions") {
  switchTab("submissions");
} else {
  api("/api/submissions").then((rows) => updatePendingBadge(rows.length)).catch(() => {});
}
