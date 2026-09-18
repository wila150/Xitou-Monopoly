const VERIFY_TYPES = [
  { value: "keyword", label: "密語（隊伍輸入文字）" },
  { value: "photo", label: "照片（小編/關主通過確認）" },
  { value: "video", label: "影片（小編/關主通過確認）" },
  { value: "referee", label: "關主直接喊過（不接受隊伍輸入）" },
];

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
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "progress") { loadProgress(); loadBroadcastScope(); }
    if (btn.dataset.tab === "referees") loadReferees();
    if (btn.dataset.tab === "leaders") loadTeamLeaders();
    if (btn.dataset.tab === "broadcasters") loadBroadcasters();
    if (btn.dataset.tab === "submissions") loadSubmissions();
    if (btn.dataset.tab === "bonus-log") loadBonusLog();
    if (btn.dataset.tab === "welcome") loadWelcomeMessage();
  });
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
      return `
        <tr>
          <td>第 ${r.groupNo} 組</td>
          <td><span class="status-tag status-${r.status}">${statusLabel}</span></td>
          <td>${r.currentIndex != null ? `${r.currentIndex}/${r.totalCheckpoints}` : "-"}</td>
          <td>${r.elapsed || "-"}</td>
          <td>${r.isLate === true ? "⚠️ 逾時" : r.isLate === false ? "準時" : "-"}</td>
          <td>${bonus !== 0 ? (bonus > 0 ? `+${bonus}` : bonus) : "-"}</td>
        </tr>
      `;
    })
    .join("");
}
document.getElementById("refresh-progress").addEventListener("click", loadProgress);

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
async function loadReferees() {
  const rows = await api("/api/referees");
  document.getElementById("referees-body").innerHTML = rows
    .map(
      (r) => `<tr><td>${r.checkpointId}</td><td>...${r.userIdSuffix}</td><td>${new Date(r.registeredAt).toLocaleString("zh-TW")}</td></tr>`
    )
    .join("");
}
document.getElementById("refresh-referees").addEventListener("click", loadReferees);

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
async function loadBroadcasters() {
  const rows = await api("/api/broadcasters");
  document.getElementById("broadcasters-body").innerHTML = rows
    .map(
      (r) => `<tr><td>...${r.userIdSuffix}</td><td>${new Date(r.registeredAt).toLocaleString("zh-TW")}</td></tr>`
    )
    .join("") || `<tr><td colspan="2" style="color:#888;">目前沒有人登記為總領隊</td></tr>`;
}
document.getElementById("refresh-broadcasters").addEventListener("click", loadBroadcasters);

// ---- 照片／影片審核佇列 ----
const submissionsMsg = document.getElementById("submissions-msg");

async function loadSubmissions() {
  const rows = await api("/api/submissions");
  const list = document.getElementById("submissions-list");
  if (rows.length === 0) {
    list.innerHTML = `<p style="color:#888;font-size:13px;">目前沒有待審核的照片／影片。</p>`;
    return;
  }
  list.innerHTML = rows
    .map((r) => {
      const mediaUrl = `/admin/api/submissions/${r.id}/media`;
      const mediaEl =
        r.mediaType === "video"
          ? `<video src="${mediaUrl}" controls style="max-width:100%;max-height:320px;border-radius:6px;"></video>`
          : `<img src="${mediaUrl}" style="max-width:100%;max-height:320px;border-radius:6px;" />`;
      return `
        <div class="cp-card" data-id="${r.id}">
          <strong>第 ${r.groupNo} 組｜${r.checkpointName}（${r.checkpointId}）</strong>
          <p style="font-size:12px;color:#888;margin:4px 0 10px;">上傳時間：${new Date(r.submittedAt).toLocaleString("zh-TW")}</p>
          ${mediaEl}
          <div class="toolbar" style="margin-top:10px;">
            <button class="btn approve-submission" data-id="${r.id}">✅ 通過</button>
            <button class="btn danger reject-submission" data-id="${r.id}">🗑 移除</button>
          </div>
        </div>
      `;
    })
    .join("");

  list.querySelectorAll(".approve-submission").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api(`/api/submissions/${btn.dataset.id}/approve`, { method: "POST" });
        showMsg(submissionsMsg, "已通過，訊息已推播給隊伍。", false);
        await loadSubmissions();
      } catch (err) {
        showMsg(submissionsMsg, err.message, true);
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
document.getElementById("refresh-submissions").addEventListener("click", loadSubmissions);

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
