const { db, transaction } = require("../db");
const { getCheckpoint, getAllCheckpoints } = require("../config/checkpoints");
const { getRoute, getAllGroupNos } = require("../config/teamsRoute");
const { getAdminIds } = require("../config/admins");
const configStore = require("../config/configStore");
const submissionStore = require("../config/submissionStore");
const { nowIso, formatElapsed, isLate } = require("./timeUtil");
const event = require("../config/event");

function textMsg(text) {
  return { type: "text", text };
}

// 訊息底下的「✅ 通過 X組」一鍵按鈕（LINE Quick Reply）：點一下等同輸入「通過 X組」，不用打字。
// 小編與登記在該關的關主都用這個；權限仍由指令本身把關（關主只能通過自己登記的那一關）。
function approveQuickReply(groupNos) {
  return {
    items: groupNos.slice(0, 13).map((g) => ({
      type: "action",
      action: { type: "message", label: `✅ 通過 ${g}組`, text: `通過 ${g}組` },
    })),
  };
}

// 密語／答案比對：自動去除頭尾空白、忽略大小寫；一關可以有多個都算對的答案，
// 在 keyword 欄位裡用「｜」或「|」分隔（例如「紅檜｜紅檜木」兩個都算對）。
function normalizeAnswer(text) {
  return String(text ?? "").trim().toLowerCase();
}

function matchesKeyword(inputText, expectedKeyword) {
  const accepted = String(expectedKeyword ?? "")
    .split(/[｜|]/)
    .map((s) => normalizeAnswer(s))
    .filter(Boolean);
  return accepted.includes(normalizeAnswer(inputText));
}

function mapUrl(mapFile) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  return `${base}/maps/${mapFile}`;
}

function imageMsg(mapFile) {
  const url = mapUrl(mapFile);
  return { type: "image", originalContentUrl: url, previewImageUrl: url };
}

// 一小段「標籤＋內容」，過關公告卡片裡「地點／玩法／過關方式」都用這個排版
function flexInfoRow(label, value) {
  return {
    type: "box",
    layout: "vertical",
    margin: "md",
    contents: [
      { type: "text", text: label, size: "xs", color: "#8a998e" },
      { type: "text", text: value, size: "sm", wrap: true, color: "#22301f" },
    ],
  };
}

// 過關公告卡片：有地圖位置圖或現場照片時當封面（hero），沒有就是純文字卡片
function checkpointFlexBubble(cp, heading, heroImage) {
  return {
    type: "bubble",
    ...(heroImage
      ? {
          hero: {
            type: "image",
            url: mapUrl(heroImage),
            size: "full",
            aspectRatio: "20:13",
            aspectMode: "cover",
          },
        }
      : {}),
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: heading, weight: "bold", size: "lg", wrap: true, color: "#3a6b45" },
        { type: "separator", margin: "md" },
        flexInfoRow("📍 地點", cp.location),
        flexInfoRow("🎮 玩法", cp.content),
        flexInfoRow("✅ 過關方式", cp.scoringMethod),
      ],
    },
  };
}

function checkpointAnnouncement(checkpointId, { isFirst = false } = {}) {
  const cp = getCheckpoint(checkpointId);
  const heading = isFirst
    ? `📍 請先移動到 ${cp.id}（${cp.name}）`
    : `🧭 請移動到 ${cp.id}（${cp.name}）`;

  const mapImages = cp.mapImages || [];
  const sitePhotos = cp.sitePhotos || [];
  // 地圖位置圖優先當卡片封面（怎麼走到這關比較急迫），現場照片留在卡片外當附加圖片參考
  const heroImage = mapImages[0] || sitePhotos[0];
  const extraImages = heroImage === mapImages[0] ? [...mapImages.slice(1), ...sitePhotos] : sitePhotos.slice(1);

  const messages = [
    { type: "flex", altText: heading, contents: checkpointFlexBubble(cp, heading, heroImage) },
  ];
  for (const img of extraImages) {
    messages.push(imageMsg(img));
  }
  return messages;
}

// ---- 內部查詢 helper ----
// exec 預設用連線池（一般讀取），在交易內會改傳 tx，讀寫都落在同一個交易裡

async function findTeam(exec, groupNo) {
  return exec.get("SELECT * FROM teams WHERE group_no = ?", [groupNo]);
}

async function findMembership(exec, userId) {
  return exec.get("SELECT * FROM team_members WHERE user_id = ?", [userId]);
}

async function requireMembership(exec, userId) {
  const member = await findMembership(exec, userId);
  if (!member) return { error: [textMsg("🙋 請先報到（輸入「報到 X組」，X 為您的組別編號）")] };
  const team = await findTeam(exec, member.group_no);
  return { member, team };
}

async function getGroupMemberIds(groupNo) {
  const rows = await db.all(
    "SELECT user_id FROM team_members WHERE group_no = ?",
    [groupNo]
  );
  return rows.map((row) => row.user_id);
}

// 關卡公告等 groupBroadcast 實際要推給誰：後台可切換「只推隊長」（預設，省 LINE 推播則數）
// 或「推全組成員」，見 configStore.getBroadcastScope()。
async function getGroupBroadcastRecipientIds(groupNo) {
  if (configStore.getBroadcastScope() === "all") {
    return getGroupMemberIds(groupNo);
  }
  const team = await findTeam(db, groupNo);
  return team && team.leader_user_id ? [team.leader_user_id] : [];
}

// 小編手動輸入「遊戲結束」之後，系統停止受理新的關卡進度（見 freezeProgress）；不會在 12:30 自動觸發
async function isProgressFrozen(exec) {
  const row = await exec.get(
    "SELECT value FROM settings WHERE key = 'progress_frozen_at'"
  );
  return !!row;
}

// ---- 登記／報到成功後主動附上「這個身分可以用的指令」，只列該身分自己的，不洩漏小編專用指令 ----

function teamHelpMsg(role, groupNo = null) {
  const lines = [
    groupNo ? `📖 使用說明｜第 ${groupNo} 組${role === "LEADER" ? "隊長" : "組員"}` : "📖 隊伍可用指令",
    "• 目前關卡：查詢這一關的地點、玩法與過關方式",
    "• 闖關進度：查詢已完成關卡數與累計耗時",
    "• 排行榜：小編開放後才能查詢",
    "• 使用說明：完整流程說明",
    "• 緊急聯絡：遇到危險、受傷或迷路，立刻通知小編處理",
    "",
    "🎯 過關方式：有關主的關卡，根據關主評估完成後通過（密語關卡請向關主取得密語後直接輸入）；沒有關主的關卡，直接上傳照片或影片，等小編確認。",
  ];
  if (role === "LEADER") {
    lines.push("", "👑 您是隊長：關卡公告會推播給您，請轉達給組員。");
  } else {
    lines.push("• 接任隊長 X組：想換隊長時發起申請（需小編核准）");
    if (configStore.getBroadcastScope() === "leader") {
      lines.push(
        "",
        "ℹ️ 目前關卡公告只會推播給隊長，想知道最新關卡可輸入「目前關卡」，或請隊長轉達。"
      );
    }
  }
  return textMsg(lines.join("\n"));
}

// guide＝true 是「使用說明」（標題帶關卡名稱），false 是剛登記完附上的簡短版；兩者都用 checkpointId 決定 B6 專屬的到站說明
function refereeHelpMsg(checkpointId = null, guide = false) {
  let title = "📖 關主可用指令";
  if (checkpointId && guide) {
    try {
      title = `📖 使用說明｜${checkpointId}「${getCheckpoint(checkpointId).name}」關主`;
    } catch {
      title = `📖 使用說明｜${checkpointId} 關主`;
    }
  }
  return textMsg(
    [
      title,
      "• 進度（或「順序」）：查看這關的預定來訪順序（依路線設定排），每組標上實際進度",
      "• 通過 X組（例如「通過 1組」）：確認該組完成您這一關，解鎖下一關（只對您登記的這一關生效）；「進度」底下有等待確認的組別時，會附「✅ 通過 X組」一鍵按鈕",
      "• 出發 X組：現場宣布出發時，開始該組計時並公布第一關",
      ...(checkpointId === "B6" ? ["• 到站 X組：隊伍抵達 B6，辦理終點確認、停止計時（只有登記在 B6 的關主能用）"] : []),
      "• 關主報到（或關主綁定）／我是 XX 關主：想換負責的關卡時重新登記",
      "• 我的ID：查詢自己的 userId",
      "• 緊急聯絡：遇到緊急狀況，立刻通知小編處理",
      "",
      "🔔 有隊伍出發或過關、正往您這關前進時，系統會自動通知您。",
    ].join("\n")
  );
}

function broadcasterHelpMsg(guide = false) {
  const message = textMsg(
    [
      guide ? "📖 使用說明｜總領隊" : "📖 總領隊可用指令",
      "• 出發 X組：現場宣布出發時，開始該組計時並公布第一關",
      "• 推播（或群發）：最簡單——點下方按鈕選對象（隊長／關主／所有人）→ 輸入內容 → 看過預覽再點「確認送出」",
      "• 推播 隊長 訊息內容：一行打完，直接送出、不用確認（對象可換成「關主」「所有人」）",
      "• 推播 隊長：先指定對象，下一則訊息就是推播內容（同樣會先預覽確認）",
      "• 取消：中途放棄推播",
      "• 我的ID：查詢自己的 userId",
      "• 緊急聯絡：遇到緊急狀況，立刻通知小編處理",
      "",
      "⚠️ 「所有人」會推給全部隊伍成員與關主，推播則數較多，請斟酌使用。",
    ].join("\n")
  );
  // 訊息底下直接附按鈕，點一下就開始推播（聊天室下方的專屬選單也有同樣的按鈕）
  message.quickReply = {
    items: [
      ["👑 推播隊長", "推播 隊長"],
      ["🚩 推播關主", "推播 關主"],
      ["👥 推播所有人", "推播 所有人"],
    ].map(([label, text]) => ({ type: "action", action: { type: "message", label, text } })),
  };
  return message;
}

function adminHelpMsg() {
  return textMsg(
    [
      "📖 使用說明｜小編",
      "• 出發 X組／到站 X組：開始計時／B6 終點確認（後台「即時進度」也有按鈕，可補登時間）",
      "• 通過 X組：任何關卡都能直接通過，不受關主登記限制",
      "• 退回 X組：退回一關（完成關卡數 -1；已終點確認的會一併取消終點確認）",
      "• 取消到站 X組：只取消誤按的終點確認，完成關卡數不變",
      "• 解除綁定 X組：清空該組的綁定與報到",
      "• 確認換隊長 X組：核准組員的換隊長申請",
      "• 加分 X組 N 理由：加分或扣分（N 可以是負數）",
      "• 進度：查看所有組別狀態",
      "• 順序 B3：查看某一關的來訪順序（也可打關卡名稱）",
      "• 遊戲結束：手動停止受理新的關卡進度（一般用不到——逾時的隊伍仍可繼續闖關，成績會標註逾時）",
      "• 排行榜開啟／排行榜關閉：控制排行榜是否公開",
      "• 處理緊急 N：接手處理某則緊急聯絡（收到警報時直接點訊息底下的「我來處理」按鈕即可）",
      "• 指定關主 B3 阿美：直接幫某人綁定成關主（名字打 LINE 顯示名稱的一部分或 userId 末 6 碼；對方要先傳過任何訊息給官方帳號）",
      "• 取消關主 阿美／指定總領隊 阿美／取消總領隊 阿美：同上",
      "• 推播（隊長／關主／所有人）：小編不用登記就能用",
      "• 重置關主／重置總領隊：清空登記",
      "• 重置遊戲 → 重置遊戲 確認：清空整場資料（不含關主與總領隊登記）",
      "",
      "🖥 完整功能請登入後台網頁 /admin（審核照片影片、編輯關卡與路線、看即時進度）。",
    ].join("\n")
  );
}

function generalGuideMsg() {
  return textMsg(
    "🌲 森呼吸．永續漫遊｜使用說明\n\n" +
      "1️⃣ 報到：輸入您的組別編號，例如「1組」或「第一組」，第一位報到者是隊長\n" +
      "2️⃣ 出發：關主確認隊伍到齊後會公布第一關\n" +
      "3️⃣ 過關：有關主的關卡根據關主評估完成後通過（密語關卡輸入關主告知的密語）；沒有關主的關卡直接上傳照片或影片，等小編確認\n" +
      "4️⃣ 查詢：「目前關卡」看這一關資訊、「闖關進度」看完成幾關與耗時\n" +
      "🚨 緊急狀況（受傷、迷路、危險）：輸入「緊急聯絡」，小編會立刻收到通知\n" +
      "5️⃣ 終點：全部關卡（或提前結束）後，帶隊伍到 B6 由工作人員辦理終點確認\n\n" +
      "完成報到後，再輸入一次「使用說明」會看到您這個身分專屬的指令。\n" +
      "有問題請直接聯繫現場小編。"
  );
}

// 「使用說明」依身分回覆不同內容：隊長／組員、關主、總領隊、小編各自只看到自己的指令，
// 同時擁有多個身分（例如關主兼總領隊、小編）就一起列出；都不是才給一般說明。
async function usageGuideFor(userId, isAdminUser) {
  const messages = [];
  const membership = await findMembership(db, userId);
  if (membership) messages.push(teamHelpMsg(membership.role, membership.group_no));
  const refereeCheckpoint = await getRefereeCheckpoint(userId);
  if (refereeCheckpoint) messages.push(refereeHelpMsg(refereeCheckpoint, true));
  if (await isBroadcaster(userId)) messages.push(broadcasterHelpMsg(true));
  if (isAdminUser) messages.push(adminHelpMsg());
  return messages.length > 0 ? messages : [generalGuideMsg()];
}

// ---- 一、報到 ----

async function checkin(groupNo, userId) {
  if (!getAllGroupNos().includes(groupNo)) {
    return [textMsg(`⚠️ 第 ${groupNo} 組不存在，請確認組別編號是否正確（1～${getAllGroupNos().length}）。`)];
  }
  const result = await checkinInTransaction(groupNo, userId);
  // 報到成功就套用小隊專屬選單（交易已提交才查得到；沒報到成功的不需要動選單）
  void syncRoleMenu(userId, { skipIfNone: true });
  return result;
}

async function checkinInTransaction(groupNo, userId) {
  return transaction(async (tx) => {
    const existing = await findMembership(tx, userId);
    if (existing) {
      if (existing.group_no === groupNo) {
        return [textMsg(`✅ 您已完成第 ${groupNo} 組報到，請等待關主宣布出發。`)];
      }
      return [
        textMsg(
          `⚠️ 您先前已綁定為第 ${existing.group_no} 組，如需更正組別請聯繫小編協助「解除綁定」。`
        ),
      ];
    }

    const team = await findTeam(tx, groupNo);
    const ts = nowIso();
    if (!team) {
      await tx.run(
        `INSERT INTO teams (group_no, status, leader_user_id, checked_in_at, current_index)
         VALUES (?, 'CHECKED_IN', ?, ?, 0)`,
        [groupNo, userId, ts]
      );
      await tx.run(
        `INSERT INTO team_members (user_id, group_no, role, joined_at) VALUES (?, ?, 'LEADER', ?)`,
        [userId, groupNo, ts]
      );
      return [
        textMsg(`✅ 報到成功！您是第 ${groupNo} 組隊長。\n請等待關主宣布出發。`),
        teamHelpMsg("LEADER"),
      ];
    }

    await tx.run(
      `INSERT INTO team_members (user_id, group_no, role, joined_at) VALUES (?, ?, 'MEMBER', ?)`,
      [userId, groupNo, ts]
    );
    return [
      textMsg(`✅ 報到成功！您已加入第 ${groupNo} 組（組員身分）。\n請等待關主宣布出發。`),
      teamHelpMsg("MEMBER"),
    ];
  });
}

// ---- 二、出發（現場關主／小編觸發，後台網頁也能觸發）----
// 每組的「出發時間」是耗時與逾時判斷的起點（見 timeUtil.isLate）。startedAt（ISO 字串，可省略）讓後台可以
// 補登實際出發的時間（例如現場已經出發、小編晚一點才按），省略就是現在；合理性檢查在呼叫端（見 parseStartedAt）。

async function depart(groupNo, startedAt = null) {
  return transaction(async (tx) => {
    const team = await findTeam(tx, groupNo);
    if (!team) {
      return { reply: [textMsg(`⚠️ 第 ${groupNo} 組尚未有任何成員報到，無法出發。`)] };
    }
    if (team.status === "IN_PROGRESS") {
      return { reply: [textMsg(`🏃 第 ${groupNo} 組已經出發過了，正在闖關中。`)] };
    }
    if (team.status === "FINISHED") {
      return { reply: [textMsg(`🏁 第 ${groupNo} 組已經辦理終點確認，無法再次出發。`)] };
    }

    const route = getRoute(groupNo);
    const ts = startedAt || nowIso();
    await tx.run(
      `UPDATE teams SET status = 'IN_PROGRESS', start_time = ?, current_index = 0 WHERE group_no = ?`,
      [ts, groupNo]
    );

    const announcement = checkpointAnnouncement(route[0].checkpointId, { isFirst: true });
    const teamMessages = [textMsg(`🚩 第 ${groupNo} 組出發！開始計時。`), ...announcement];
    const refereePushes = await getRefereePushesForCheckpoint(route[0].checkpointId, groupNo);

    return {
      reply: [
        textMsg(
          `🚩 已將第 ${groupNo} 組標記為出發` + (startedAt ? `（出發時間 ${taipeiTime(startedAt)}）` : "") + "。"
        ),
      ],
      groupBroadcast: { groupNo, messages: teamMessages },
      directPushes: refereePushes,
    };
  });
}

// ---- 三、關卡過關 ----
// 三種過關方式：
//   'keyword' （A3、A5）：隊伍直接輸入關主口頭告知的密語，比對正確立即過關
//   'photo' / 'video'（無關主的 6 關）：隊伍上傳照片／影片先送審，小編或關主打「通過 X組」才真正過關
//   'referee' （B3、B4、D6、C4）：隊伍不需要輸入任何東西，關主現場確認完成後，
//              由關主或小編直接打「通過 X組」過關（沒有「送審中」這個中間狀態）

// 檢查「這個人現在能不能嘗試過關」，回傳 { blocked } 表示要直接回覆／不回覆，
// 或 { team, route, expected, cp } 表示可以繼續往下判斷關鍵字／媒體
async function checkAttemptGuards(tx, userId) {
  const { error, team } = await requireMembership(tx, userId);
  if (error) return { blocked: error };

  if (team.status === "CHECKED_IN") {
    return { blocked: [textMsg("⏳ 尚未出發，請等待關主宣布出發。")] };
  }
  if (team.status === "FINISHED") {
    return { blocked: null }; // 已辦理終點確認的隊伍，系統不再回應
  }

  const route = getRoute(team.group_no);
  if (team.current_index >= route.length) {
    return {
      blocked: [textMsg(`🎉 貴隊已完成全部 ${route.length} 關，請儘速前往 B6 辦理終點確認！`)],
    };
  }

  if (await isProgressFrozen(tx)) {
    return { blocked: [textMsg("⏰ 已停止受理新的關卡進度，請儘速前往 B6 辦理終點確認。")] };
  }

  const expected = route[team.current_index];
  const cp = getCheckpoint(expected.checkpointId);
  return { team, route, expected, cp };
}

// 隊伍出發／過關前進到某一關時，主動通知登記在該關的關主「有隊伍正往你這關來」，
// 關主才不用被動等隊伍走到面前才知道。同一關可能有多個人登記，全部都通知。
async function getRefereePushesForCheckpoint(checkpointId, groupNo) {
  const rows = await db.all("SELECT user_id FROM referees WHERE checkpoint_id = ?", [
    checkpointId,
  ]);
  if (rows.length === 0) return [];
  const cp = getCheckpoint(checkpointId);
  const message = textMsg(`🚶 第 ${groupNo} 組正往您這關（${cp.id}｜${cp.name}）前進，請留意。`);
  return rows.map((r) => ({ to: r.user_id, messages: [message] }));
}

// 實際過關：寫紀錄、往下一關前進，回傳「通關確認＋下一關公告」訊息，以及要通知下一關關主的推播
async function advanceCheckpoint(tx, team, expected, cp, route) {
  const ts = nowIso();
  await tx.run(
    `INSERT INTO checkpoint_log (group_no, checkpoint_index, checkpoint_id, passed_at) VALUES (?, ?, ?, ?)`,
    [team.group_no, team.current_index, expected.checkpointId, ts]
  );

  const newIndex = team.current_index + 1;
  await tx.run(`UPDATE teams SET current_index = ? WHERE group_no = ?`, [
    newIndex,
    team.group_no,
  ]);
  // 該組通過這一關後，先前留在審核佇列裡的待審照片／影片就沒用了，一併清掉
  await submissionStore.deleteSubmissionsForGroup(team.group_no);

  const confirm = textMsg(`✅ 通關：${cp.name}`);

  if (newIndex >= route.length) {
    return {
      teamMessages: [
        confirm,
        textMsg(`🎉 恭喜完成所有 ${route.length} 關！請儘速前往 B6 辦理終點確認。`),
      ],
      refereePushes: [],
    };
  }

  const next = route[newIndex];
  const refereePushes = await getRefereePushesForCheckpoint(next.checkpointId, team.group_no);
  return { teamMessages: [confirm, ...checkpointAnnouncement(next.checkpointId)], refereePushes };
}

// ---- 三之一、有關主的 6 關：關鍵字比對正確後立即過關 ----

// 回傳 { reply, directPushes }：reply 是要直接回覆給打關鍵字的人的訊息，
// directPushes 是過關成功時要主動通知下一關關主的推播（見 getRefereePushesForCheckpoint）。
async function verifyKeyword(userId, text) {
  return transaction(async (tx) => {
    const guard = await checkAttemptGuards(tx, userId);
    if (guard.blocked !== undefined) return { reply: guard.blocked, directPushes: [] };
    const { team, route, expected, cp } = guard;

    if (cp.verifyType === "referee") {
      return {
        reply: [
          textMsg("🙋 這一關由關主現場確認完成，不需要輸入任何文字，請等待關主或小編為您解鎖下一關。"),
        ],
        directPushes: [],
      };
    }
    if (cp.verifyType !== "keyword") {
      const kind = cp.verifyType === "video" ? "影片" : "照片";
      return {
        reply: [textMsg(`📷 這一關沒有現場關主，請直接上傳${kind}，不需要輸入文字關鍵字。`)],
        directPushes: [],
      };
    }
    if (!matchesKeyword(text, expected.keyword)) {
      return { reply: [textMsg("❌ 不正確，請向關主確認。")], directPushes: [] };
    }

    const { teamMessages, refereePushes } = await advanceCheckpoint(tx, team, expected, cp, route);
    return { reply: teamMessages, directPushes: refereePushes };
  });
}

// ---- 三之二、無關主的 6 關：上傳照片／影片後先送審，小編「通過 X組」才真正過關 ----

// media（可省略）：{ buffer, mimeType } 是從 LINE 下載到的實際照片／影片內容，
// 存進審核佇列讓後台網頁「照片／影片審核」分頁可以直接預覽。太大（見 submissionStore）或呼叫端沒傳就不存，
// 退回純文字通知＋LINE聊天記錄查看的舊方式，行為不會壞掉。
async function submitMedia(userId, media = null, { lineMessageId = null } = {}) {
  return transaction(async (tx) => {
    const guard = await checkAttemptGuards(tx, userId);
    if (guard.blocked !== undefined) return { reply: guard.blocked, adminNotify: [] };
    const { team, cp } = guard;

    if (cp.verifyType === "referee") {
      return {
        reply: [
          textMsg(
            "🙋 這一關由關主現場確認完成，不需要上傳照片或影片，請等待關主或小編為您解鎖下一關。"
          ),
        ],
        adminNotify: [],
      };
    }
    if (cp.verifyType === "keyword") {
      return {
        reply: [textMsg("🔑 這一關需要向關主取得關鍵字才能過關，請直接輸入文字關鍵字。")],
        adminNotify: [],
      };
    }

    const kind = cp.verifyType === "video" ? "影片" : "照片";
    // 有內容就直接存；沒抓到內容但有 LINE 訊息 ID（通常是影片還在轉檔）就先存一筆「等待下載」的紀錄，
    // 讓小編馬上看得到這筆送審，呼叫端會在背景重試下載（見 mediaRetry.js）。
    const submissionId = await submissionStore.saveSubmission({
      groupNo: team.group_no,
      checkpointId: cp.id,
      mediaType: cp.verifyType,
      mimeType: media ? media.mimeType : cp.verifyType === "video" ? "video/mp4" : "image/jpeg",
      buffer: media ? media.buffer : null,
      submittedBy: userId,
      lineMessageId,
    });
    const stored = submissionId !== null;
    const awaitingDownload = stored && !media;
    const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const adminText = awaitingDownload
      ? `📸 第 ${team.group_no} 組在「${cp.name}」上傳了${kind}，LINE 還在處理，後台預覽稍後會自動出現（也可以直接到官方帳號聊天記錄確認）。\n` +
        `確認沒問題請輸入「通過 ${team.group_no}組」，或在後台按「✅ 通過」解鎖下一關。` +
        (base ? `\n👉 ${base}/admin#submissions` : "")
      : stored
      ? `📸 第 ${team.group_no} 組在「${cp.name}」上傳了${kind}，可至後台網頁「照片／影片審核」分頁直接預覽。\n` +
        `確認沒問題請輸入「通過 ${team.group_no}組」，或直接在後台按「✅ 通過」解鎖下一關。` +
        (base ? `\n👉 ${base}/admin#submissions` : "")
      : `📸 第 ${team.group_no} 組在「${cp.name}」上傳了${kind}` +
        (media ? "" : "（後台預覽失敗）") +
        `，請至官方帳號聊天記錄確認內容。\n` +
        `確認沒問題請輸入「通過 ${team.group_no}組」解鎖下一關。`;
    // 訊息底下附「一鍵通過」按鈕：小編點一下就等同輸入「通過 X組」，不用打字
    const adminMessages = [{ ...textMsg(adminText), quickReply: approveQuickReply([team.group_no]) }];
    const adminIds = getAdminIds();
    const notify = adminIds.map((adminId) => ({ to: adminId, messages: adminMessages }));

    // 登記在這一關的關主（例如 B6 終點工作人員）也會收到，可以現場確認後直接點按鈕通過（只對自己登記的這一關有效）。
    // 關主看不到後台預覽，所以訊息寫成「請現場確認」，不附後台連結；同時是小編的人已經收過一份，不重複。
    const refereeRows = await tx.all("SELECT user_id FROM referees WHERE checkpoint_id = ?", [cp.id]);
    const refereeMessages = [
      {
        ...textMsg(
          `📸 第 ${team.group_no} 組在您這關「${cp.name}」上傳了${kind}。\n請現場確認任務完成後，點下方按鈕或輸入「通過 ${team.group_no}組」。`
        ),
        quickReply: approveQuickReply([team.group_no]),
      },
    ];
    for (const { user_id: refereeId } of refereeRows) {
      if (!adminIds.includes(refereeId)) notify.push({ to: refereeId, messages: refereeMessages });
    }
    return {
      reply: [textMsg(`📮 已收到您上傳的${kind}，請等待${refereeRows.length > 0 ? "小編或關主" : "小編"}確認後解鎖下一關。`)],
      adminNotify: notify,
      // 有值代表這筆還沒抓到內容，呼叫端要排程重試下載
      pendingDownloadId: awaitingDownload ? submissionId : null,
    };
  });
}

// ---- 三之三、小編手動核准目前這關（適用任何類型：關主關卡或照片／影片關卡）----
// 小編（不傳 restrictToCheckpointId）對任何關卡都能直接喊過；
// 登記過的關主（有傳 restrictToCheckpointId）只能核准「該組目前剛好在自己登記的那一關」，
// 避免關主誤觸或跨關卡核准到不相關的隊伍。

async function approveCheckpoint(groupNo, restrictToCheckpointId = null) {
  return transaction(async (tx) => {
    const team = await findTeam(tx, groupNo);
    if (!team) {
      return { reply: [textMsg(`⚠️ 第 ${groupNo} 組尚未有任何成員報到。`)] };
    }
    if (team.status === "CHECKED_IN") {
      return { reply: [textMsg(`⏳ 第 ${groupNo} 組尚未出發。`)] };
    }
    if (team.status === "FINISHED") {
      return { reply: [textMsg(`🏁 第 ${groupNo} 組已經辦理終點確認，無需再確認關卡。`)] };
    }

    const route = getRoute(groupNo);
    if (team.current_index >= route.length) {
      return { reply: [textMsg(`🎉 第 ${groupNo} 組已完成全部 ${route.length} 關，無需再確認。`)] };
    }

    if (await isProgressFrozen(tx)) {
      return {
        reply: [
          textMsg(
            `⏰ 已停止受理新的關卡進度，無法再為第 ${groupNo} 組確認關卡（終點確認功能不受影響）。`
          ),
        ],
      };
    }

    const expected = route[team.current_index];
    const cp = getCheckpoint(expected.checkpointId);

    if (restrictToCheckpointId && expected.checkpointId !== restrictToCheckpointId) {
      return {
        reply: [
          textMsg(
            `⚠️ 第 ${groupNo} 組目前這關是「${cp.name}」（${cp.id}），不是您登記的關卡，無法用這個帳號通過。`
          ),
        ],
      };
    }

    const { teamMessages, refereePushes } = await advanceCheckpoint(tx, team, expected, cp, route);
    return {
      reply: [textMsg(`✅ 已為第 ${groupNo} 組確認「${cp.name}」通過。`)],
      groupBroadcast: { groupNo, messages: teamMessages },
      directPushes: refereePushes,
    };
  });
}

// 給後台網頁「照片／影片審核」分頁：待審核清單（含關卡名稱），以及按鈕「通過」「移除」對應的動作
async function listPendingSubmissions() {
  const rows = await submissionStore.listPending();
  return rows.map((r) => {
    let checkpointName = r.checkpoint_id;
    try {
      checkpointName = getCheckpoint(r.checkpoint_id).name;
    } catch {
      // 關卡設定被刪掉的極端情況，退回顯示代號
    }
    return {
      id: r.id,
      groupNo: r.group_no,
      checkpointId: r.checkpoint_id,
      checkpointName,
      mediaType: r.media_type,
      submittedAt: r.submitted_at,
      hasData: !!r.has_data,
      downloadError: r.download_error,
      downloadAttempts: r.download_attempts,
    };
  });
}

async function approveSubmissionById(id) {
  const meta = await submissionStore.getSubmissionMeta(id);
  if (!meta) {
    return { reply: [textMsg("這筆待審核紀錄已經不存在了，可能已經被處理過。")] };
  }
  // 後台網頁按「通過」視同小編權限，不限制關卡（跟 LINE 指令「通過 X組」小編那條路徑一致）
  return approveCheckpoint(meta.group_no, null);
}

// ---- 三之五、關主自助登記：「我是 B3 關主」----
// 防呆：已經報到綁定某一組的人不能再登記成關主，避免隊伍自己登記自己那關的關主幫自己過關。

// 「已經是隊伍成員」擋下登記時的說法：自助登記是對本人說話（您），後台指定是對小編說話（這個帳號）
function memberBlockedMessage(membership, roleLabel, self) {
  const subject = self ? "您" : "這個帳號";
  const remedy = self ? "請聯繫小編協助「解除綁定」後再重新登記" : "請先「解除綁定」後再登記";
  return `⚠️ ${subject}已經是第 ${membership.group_no} 組的成員，無法同時登記為${roleLabel}。若這是誤觸的隊伍報到，${remedy}。`;
}

// 登記關主（自助登記與後台指定共用）：成功回傳 { ok: true, cp }，不能登記回傳 { ok: false, error: 訊息 }
async function tryRegisterReferee(userId, checkpointId, { self = false } = {}) {
  let cp;
  try {
    cp = getCheckpoint(checkpointId);
  } catch {
    return { ok: false, error: `⚠️ 找不到關卡代號「${checkpointId}」，請確認輸入是否正確。` };
  }

  const membership = await findMembership(db, userId);
  if (membership) {
    return { ok: false, error: memberBlockedMessage(membership, "關主", self) };
  }

  await db.run(
    `INSERT INTO referees (user_id, checkpoint_id, registered_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET checkpoint_id = excluded.checkpoint_id, registered_at = excluded.registered_at`,
    [userId, checkpointId, nowIso()]
  );
  void syncRoleMenu(userId);
  return { ok: true, cp };
}

async function registerReferee(userId, checkpointId) {
  const result = await tryRegisterReferee(userId, checkpointId, { self: true });
  if (!result.ok) return [textMsg(result.error)];
  const { cp } = result;
  return [
    textMsg(
      `✅ 已登記為「${cp.name}」（${cp.id}）的關主。之後隊伍在這一關完成任務後，直接輸入「通過 X組」即可為該組解鎖下一關。`
    ),
    refereeHelpMsg(checkpointId),
  ];
}

// 後台指定關主：不需要對方自己傳訊息。成功會回傳要推播給對方的通知（含指令說明）。
async function assignReferee(userId, checkpointId) {
  const result = await tryRegisterReferee(userId, checkpointId);
  if (!result.ok) return { ok: false, error: result.error.replace(/^⚠️ /, "") };
  const { cp } = result;
  return {
    ok: true,
    message: `已指定為「${cp.name}」（${cp.id}）的關主`,
    pushes: [
      {
        to: userId,
        messages: [textMsg(`📌 小編已指定您擔任「${cp.name}」（${cp.id}）的關主。`), refereeHelpMsg(checkpointId)],
      },
    ],
  };
}

async function removeReferee(userId) {
  const row = await db.get("SELECT checkpoint_id FROM referees WHERE user_id = ?", [userId]);
  if (!row) return { ok: false, error: "這個帳號目前不是關主" };
  await db.run("DELETE FROM referees WHERE user_id = ?", [userId]);
  void syncRoleMenu(userId);
  return {
    ok: true,
    message: `已取消 ${row.checkpoint_id} 關主`,
    pushes: [{ to: userId, messages: [textMsg(`ℹ️ 小編已取消您的關主身分（${row.checkpoint_id}）。如有疑問請聯繫小編。`)] }],
  };
}

// 用關卡代號（例如 B3）或關卡名稱（例如 救救菜英文）找關卡，代號不分大小寫，找不到回傳 null
function findCheckpointByIdOrName(text) {
  const normalized = text.trim();
  if (!normalized) return null;
  return (
    getAllCheckpoints().find(
      (cp) => cp.id.toLowerCase() === normalized.toLowerCase() || cp.name === normalized
    ) || null
  );
}

// 關主也能像隊伍報到一樣，單獨回覆關卡代號或名稱就完成登記（不用一定要打「我是 XX 關主」）。
// 只有「目前不是任何隊伍成員」的帳號才會走這條路徑，回傳 null 表示不適用（例如已經是隊伍成員，
// 這種情況下該讓文字繼續走關鍵字比對流程，不要被誤判成要登記關主）。
async function tryRefereeBareRegistration(userId, text) {
  const membership = await findMembership(db, userId);
  if (membership) return null;
  const cp = findCheckpointByIdOrName(text);
  if (!cp) return null;
  return registerReferee(userId, cp.id);
}

async function getRefereeCheckpoint(userId) {
  const row = await db.get("SELECT checkpoint_id FROM referees WHERE user_id = ?", [
    userId,
  ]);
  return row ? row.checkpoint_id : null;
}

// 小編專用：清空所有關主登記（跟「重置遊戲」分開，不會因為重置整場遊戲而被順便清掉，
// 需要的時候才手動清，例如發現有人誤登記、或活動結束後要收回名單）
async function resetReferees() {
  const affected = (await db.all("SELECT user_id FROM referees")).map((r) => r.user_id);
  await db.run("DELETE FROM referees");
  void syncRoleMenus(affected);
  return [textMsg("♻️ 已清空所有關主登記，需要的人請重新輸入「我是 XX 關主」登記。")];
}

// 給後台網頁看目前有哪些人登記成哪一關的關主（不含 userId 全碼，只顯示末 6 碼方便辨識，保留一點隱私）
async function listReferees() {
  const rows = await db.all(
    `SELECT r.user_id, r.checkpoint_id, r.registered_at, u.display_name
     FROM referees r LEFT JOIN line_users u ON u.user_id = r.user_id
     ORDER BY r.checkpoint_id`
  );
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    userIdSuffix: r.user_id.slice(-6),
    checkpointId: r.checkpoint_id,
    registeredAt: r.registered_at,
  }));
}

// 給後台網頁看目前每組的小隊長是誰（不含 userId 全碼，只顯示末 6 碼方便辨識，保留一點隱私）
async function listTeamLeaders() {
  const rows = await db.all(
    `SELECT t.group_no, t.leader_user_id, t.status, tm.joined_at, u.display_name
     FROM teams t
     LEFT JOIN team_members tm ON tm.user_id = t.leader_user_id
     LEFT JOIN line_users u ON u.user_id = t.leader_user_id
     WHERE t.leader_user_id IS NOT NULL
     ORDER BY t.group_no`
  );
  return rows.map((r) => ({
    groupNo: r.group_no,
    displayName: r.display_name,
    userIdSuffix: r.leader_user_id.slice(-6),
    status: r.status,
    joinedAt: r.joined_at,
  }));
}

// ---- 三之五、總領隊自助登記與推播（不需要是 ADMIN_USER_IDS，也能對隊長／關主／所有人推播）----

async function tryRegisterBroadcaster(userId, { self = false } = {}) {
  const membership = await findMembership(db, userId);
  if (membership) {
    return { ok: false, error: memberBlockedMessage(membership, "總領隊", self) };
  }
  await db.run(
    `INSERT INTO broadcasters (user_id, registered_at) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET registered_at = excluded.registered_at`,
    [userId, nowIso()]
  );
  void syncRoleMenu(userId);
  return { ok: true };
}

async function registerBroadcaster(userId) {
  const result = await tryRegisterBroadcaster(userId, { self: true });
  if (!result.ok) return [textMsg(result.error)];
  return [textMsg("✅ 已登記為總領隊。"), broadcasterHelpMsg()];
}

// 後台指定總領隊
async function assignBroadcaster(userId) {
  const result = await tryRegisterBroadcaster(userId);
  if (!result.ok) return { ok: false, error: result.error.replace(/^⚠️ /, "") };
  return {
    ok: true,
    message: "已指定為總領隊",
    pushes: [{ to: userId, messages: [textMsg("📌 小編已指定您擔任總領隊。"), broadcasterHelpMsg()] }],
  };
}

async function removeBroadcaster(userId) {
  const row = await db.get("SELECT user_id FROM broadcasters WHERE user_id = ?", [userId]);
  if (!row) return { ok: false, error: "這個帳號目前不是總領隊" };
  await db.run("DELETE FROM broadcasters WHERE user_id = ?", [userId]);
  void syncRoleMenu(userId);
  return {
    ok: true,
    message: "已取消總領隊",
    pushes: [{ to: userId, messages: [textMsg("ℹ️ 小編已取消您的總領隊身分。如有疑問請聯繫小編。")] }],
  };
}

async function isBroadcaster(userId) {
  const row = await db.get("SELECT 1 FROM broadcasters WHERE user_id = ?", [userId]);
  return !!row;
}

// 小編專用：清空所有總領隊登記（跟「重置關主」同樣的設計，不會因為重置整場遊戲而被順便清掉）
async function resetBroadcasters() {
  const affected = (await db.all("SELECT user_id FROM broadcasters")).map((r) => r.user_id);
  await db.run("DELETE FROM broadcasters");
  void syncRoleMenus(affected);
  return [textMsg("♻️ 已清空所有總領隊登記。")];
}

// 給後台網頁看目前有哪些人登記成總領隊（不含 userId 全碼，只顯示末 6 碼方便辨識，保留一點隱私）
// 用 LINE 指令指定關主／總領隊時，從「傳過訊息給官方帳號的人」裡找人：
// 可以打完整 userId、userId 末 6 碼以上、或 LINE 顯示名稱（完全相同優先，其次名稱包含關鍵字）。
// 回傳 { status: "ok", user } ／ { status: "none" } ／ { status: "ambiguous", candidates }
async function findLineUser(query) {
  const q = String(query || "").trim();
  if (!q) return { status: "none" };
  const users = await db.all("SELECT user_id, display_name FROM line_users ORDER BY last_seen_at DESC");
  const lower = q.toLowerCase();

  const byId = users.filter((u) => u.user_id === q);
  if (byId.length === 1) return { status: "ok", user: byId[0] };

  // 完整 userId（U 加 32 位十六進位）就算不在名單裡也能直接用：之前留過言、但這個版本上線前的人，
  // userId 在 Render 的 Logs（搜尋「收到訊息：userId=」）裡找得到。順手記進名單並嘗試補上顯示名稱。
  if (/^U[0-9a-f]{32}$/i.test(q)) {
    const now = nowIso();
    await db.run(
      `INSERT INTO line_users (user_id, first_seen_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING`,
      [q, now, now]
    );
    const name = await lookupDisplayName(q);
    if (name) await db.run("UPDATE line_users SET display_name = ? WHERE user_id = ?", [name, q]);
    return { status: "ok", user: { user_id: q, display_name: name } };
  }

  // 末碼：至少 6 個英數字才當作 userId 片段，避免「小明」之類的名字被誤判
  const bySuffix = /^[A-Za-z0-9]{6,}$/.test(q) ? users.filter((u) => u.user_id.toLowerCase().endsWith(lower)) : [];
  if (bySuffix.length === 1) return { status: "ok", user: bySuffix[0] };
  if (bySuffix.length > 1) return { status: "ambiguous", candidates: bySuffix.slice(0, 5) };

  const exact = users.filter((u) => (u.display_name || "").toLowerCase() === lower);
  if (exact.length === 1) return { status: "ok", user: exact[0] };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact.slice(0, 5) };

  const partial = users.filter((u) => (u.display_name || "").toLowerCase().includes(lower));
  if (partial.length === 1) return { status: "ok", user: partial[0] };
  if (partial.length > 1) return { status: "ambiguous", candidates: partial.slice(0, 5) };
  return { status: "none" };
}

function lineUserDisplay(u) {
  return `${u.display_name || "（未取得名稱）"} …${u.user_id.slice(-6)}`;
}

// 小編用 LINE 指令指定／取消關主與總領隊（後台網頁有同樣功能）。找不到人、名字重複時提示怎麼改打。
// 對方至少要傳過一句話給官方帳號才找得到（LINE 沒有列出全部好友的 API）。
async function adminRoleCommand(kind, action, query, checkpointId = null) {
  const found = await findLineUser(query);
  if (found.status === "none") {
    return {
      reply: [
        textMsg(
          `🔎 找不到「${query}」。對方需要先傳任何一句話給官方帳號（例如「我的ID」），才找得到人；名字可以打 LINE 顯示名稱的一部分，或 userId 末 6 碼以上。之前就留過言的人，也可以直接貼完整 userId（Render Logs 搜尋「收到訊息：userId=」）。`
        ),
      ],
    };
  }
  if (found.status === "ambiguous") {
    const list = found.candidates.map((u, i) => `${i + 1}. ${lineUserDisplay(u)}`).join("\n");
    return {
      reply: [textMsg(`🤔 符合的人不只一位，請改打 userId 末 6 碼指定：\n${list}`)],
    };
  }
  const { user } = found;
  let result;
  if (kind === "referee") {
    result = action === "assign" ? await assignReferee(user.user_id, checkpointId) : await removeReferee(user.user_id);
  } else {
    result = action === "assign" ? await assignBroadcaster(user.user_id) : await removeBroadcaster(user.user_id);
  }
  if (!result.ok) return { reply: [textMsg(`⚠️ ${lineUserDisplay(user)}：${result.error}`)] };
  return {
    reply: [textMsg(`✅ ${lineUserDisplay(user)} ${result.message}，已通知對方。`)],
    directPushes: result.pushes,
  };
}

// 後台「指定關主／總領隊」用的人員清單：最近有互動的排前面，並標出每個人目前的身分，避免指定到已在隊伍裡的人
async function listLineUsers() {
  const rows = await db.all(
    `SELECT u.user_id, u.display_name, u.last_seen_at,
            tm.group_no, tm.role, r.checkpoint_id, (b.user_id IS NOT NULL) AS is_broadcaster
     FROM line_users u
     LEFT JOIN team_members tm ON tm.user_id = u.user_id
     LEFT JOIN referees r ON r.user_id = u.user_id
     LEFT JOIN broadcasters b ON b.user_id = u.user_id
     ORDER BY u.last_seen_at DESC`
  );
  const adminIds = getAdminIds();
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    userIdSuffix: r.user_id.slice(-6),
    lastSeenAt: r.last_seen_at,
    teamLabel: r.group_no ? `第 ${r.group_no} 組${r.role === "LEADER" ? "隊長" : "組員"}` : null,
    isTeamMember: !!r.group_no,
    refereeCheckpointId: r.checkpoint_id || null,
    isBroadcaster: !!r.is_broadcaster,
    isAdmin: adminIds.includes(r.user_id),
  }));
}

async function listBroadcasters() {
  const rows = await db.all(
    `SELECT b.user_id, b.registered_at, u.display_name
     FROM broadcasters b LEFT JOIN line_users u ON u.user_id = b.user_id
     ORDER BY b.registered_at`
  );
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    userIdSuffix: r.user_id.slice(-6),
    registeredAt: r.registered_at,
  }));
}

// 推播對象：leader＝各組目前的隊長、referee＝所有登記過的關主、all＝所有隊伍成員（隊長＋隊員）加上關主（去重複）
const BROADCAST_TARGET_LABELS = { leader: "小隊長", referee: "關主", all: "所有人" };

async function resolveBroadcastRecipients(target) {
  if (target === "leader") {
    const rows = await db.all("SELECT leader_user_id AS id FROM teams WHERE leader_user_id IS NOT NULL");
    return rows.map((r) => r.id);
  }
  if (target === "referee") {
    const rows = await db.all("SELECT user_id AS id FROM referees");
    return rows.map((r) => r.id);
  }
  const rows = await db.all(
    "SELECT user_id AS id FROM team_members UNION SELECT user_id AS id FROM referees"
  );
  return rows.map((r) => r.id);
}

// 總領隊／小編的「推播」：依對象（leader／referee／all）對一群人各推一則文字訊息。
// 推播則數 = 收件人數（LINE 計費以請求次數 x 收件人數計算），「所有人」會比只推隊長多很多，請留意額度。
// 推播前先告訴總領隊「這會發給幾個人」（確認畫面用）
async function countBroadcastRecipients(target) {
  return (await resolveBroadcastRecipients(target)).length;
}

async function broadcastMessage(target, text) {
  const label = BROADCAST_TARGET_LABELS[target];
  const ids = await resolveBroadcastRecipients(target);
  const message = textMsg(`📢 總領隊訊息\n${text}`);
  const directPushes = ids.map((id) => ({ to: id, messages: [message] }));
  let replyText;
  if (ids.length === 0) {
    replyText = `⚠️ 目前沒有可以接收推播的${label}（尚未有人報到或登記）。`;
  } else if (target === "all") {
    replyText = `📢 已推播給所有人（共 ${ids.length} 位）。`;
  } else {
    replyText = `📢 已推播給 ${ids.length} 位${label}。`;
  }
  return { reply: [textMsg(replyText)], directPushes };
}

// ---- 三之四、退回一關（更正「通過」／「到站」誤觸或手滑重複的情況）----
// 「通過」不是天然冪等的操作（每按一次就前進一關），連按兩次或按錯組別都沒有事前防呆，
// 這裡提供事後更正的方式。「退回」每次都真的退一關（完成關卡數 -1、該關通過紀錄刪除）：
// 已經辦理終點確認的組別也一樣，會一併取消終點確認、清掉結束時間與逾時標記，計時從出發時間繼續累加，
// 之後真正到站時再重新記錄結束時間。只想取消誤按的「到站」、不想退關卡的話用「取消到站」（見 cancelFinish）。

async function revertLastCheckpoint(groupNo) {
  return transaction(async (tx) => {
    const team = await findTeam(tx, groupNo);
    if (!team) {
      return { reply: [textMsg(`⚠️ 第 ${groupNo} 組尚未有任何成員報到。`)] };
    }
    const wasFinished = team.status === "FINISHED";

    if (team.status === "CHECKED_IN" || team.current_index === 0) {
      if (!wasFinished) {
        return { reply: [textMsg(`⚠️ 第 ${groupNo} 組目前沒有可以退回的關卡進度。`)] };
      }
      // 還沒完成任何關卡就被終點確認：沒有關卡可退，只能取消終點確認
      return cancelFinishInTx(tx, team);
    }

    const newIndex = team.current_index - 1;
    const route = getRoute(groupNo);
    const revertedStep = route[newIndex];
    const cp = getCheckpoint(revertedStep.checkpointId);

    await tx.run(
      `DELETE FROM checkpoint_log WHERE group_no = ? AND checkpoint_index = ?`,
      [groupNo, newIndex]
    );
    await tx.run(
      `UPDATE teams SET current_index = ?, status = 'IN_PROGRESS', finish_time = NULL, is_late = 0 WHERE group_no = ?`,
      [newIndex, groupNo]
    );

    const finishNote = wasFinished ? "，並一併取消終點確認（該組恢復闖關中，計時繼續累加）" : "";
    return {
      reply: [
        textMsg(
          `♻️ 已將第 ${groupNo} 組退回到「${cp.name}」（${newIndex}/${event.totalCheckpoints} 關）${finishNote}，該關重新視為未完成。`
        ),
      ],
      groupBroadcast: {
        groupNo,
        messages: [
          textMsg(
            `⚠️ 小編剛剛更正了進度：「${cp.name}」重新視為未完成${wasFinished ? "，終點確認也已取消" : ""}，請重新完成這一關的任務。`
          ),
        ],
      },
      directPushes: await getRefereePushesForCheckpoint(cp.id, groupNo),
    };
  });
}

// 只取消終點確認，完成關卡數不變（誤按「到站」時用）
async function cancelFinishInTx(tx, team) {
  const groupNo = team.group_no;
  await tx.run(
    `UPDATE teams SET status = 'IN_PROGRESS', finish_time = NULL, is_late = 0 WHERE group_no = ?`,
    [groupNo]
  );
  return {
    reply: [
      textMsg(
        `♻️ 已取消第 ${groupNo} 組的終點確認（完成關卡數維持 ${team.current_index}/${event.totalCheckpoints}），該組恢復為闖關中，計時繼續累加。`
      ),
    ],
    groupBroadcast: {
      groupNo,
      messages: [textMsg("⚠️ 小編剛剛取消了終點確認，貴隊狀態恢復為闖關中，請留意後續指示。")],
    },
  };
}

async function cancelFinish(groupNo) {
  return transaction(async (tx) => {
    const team = await findTeam(tx, groupNo);
    if (!team) {
      return { reply: [textMsg(`⚠️ 第 ${groupNo} 組尚未有任何成員報到。`)] };
    }
    if (team.status !== "FINISHED") {
      return { reply: [textMsg(`ℹ️ 第 ${groupNo} 組目前沒有終點確認可以取消。`)] };
    }
    return cancelFinishInTx(tx, team);
  });
}

// ---- 四、B6 終點確認（由 B6 終點工作人員現場觸發，模式同「出發 X組」）----

// finishedAt（ISO 字串，可省略）讓後台可以補登實際到站的時間，省略就是現在；合理性檢查（不是未來等）在呼叫端，
// 這裡只檢查不能早於該組的出發時間。
async function finishAtB6(groupNo, finishedAt = null) {
  return transaction(async (tx) => {
    const team = await findTeam(tx, groupNo);
    if (!team) {
      return { reply: [textMsg(`⚠️ 第 ${groupNo} 組尚未有任何成員報到，無法辦理終點確認。`)] };
    }
    if (team.status === "CHECKED_IN") {
      return { reply: [textMsg(`⏳ 第 ${groupNo} 組尚未出發，無法辦理終點確認。`)] };
    }
    if (team.status === "FINISHED") {
      const elapsed = formatElapsed(team.start_time, team.finish_time);
      return {
        reply: [
          textMsg(
            `🏁 第 ${groupNo} 組已經辦理過終點確認了。\n完成關卡數：${team.current_index}/${event.totalCheckpoints}\n總耗時：${elapsed}`
          ),
        ],
      };
    }

    const ts = finishedAt || nowIso();
    if (new Date(ts).getTime() < new Date(team.start_time).getTime()) {
      return {
        reply: [
          textMsg(
            `⚠️ 到站時間不能早於第 ${groupNo} 組的出發時間（${taipeiTime(team.start_time)}），請確認補登的時間。`
          ),
        ],
      };
    }
    const late = isLate(team.start_time, ts) ? 1 : 0;
    await tx.run(
      `UPDATE teams SET status = 'FINISHED', finish_time = ?, is_late = ? WHERE group_no = ?`,
      [ts, late, groupNo]
    );

    const elapsed = formatElapsed(team.start_time, ts);
    const teamMessages = [
      textMsg(
        `🏁 終點確認成功！\n完成關卡數：${team.current_index}/${event.totalCheckpoints}\n總耗時：${elapsed}`
      ),
    ];
    if (late) {
      teamMessages.push(
        textMsg(`⚠️ 出發後已超過 ${event.maxDurationMinutes / 60} 小時，將標註為「逾時」。`)
      );
    }

    return {
      reply: [
        textMsg(
          `🏁 已為第 ${groupNo} 組辦理終點確認` +
            (finishedAt ? `（到站時間 ${taipeiTime(finishedAt)}）` : "") +
            `。完成關卡數：${team.current_index}/${event.totalCheckpoints}，總耗時：${elapsed}${late ? "（逾時）" : ""}`
        ),
      ],
      groupBroadcast: { groupNo, messages: teamMessages },
    };
  });
}

// ---- 五、凍結關卡進度（只有小編手動「遊戲結束」會觸發，沒有排程；不會產生終點確認）----

async function freezeProgress() {
  return transaction(async (tx) => {
    const already = await isProgressFrozen(tx);
    if (!already) {
      await tx.run(
        `INSERT INTO settings (key, value) VALUES ('progress_frozen_at', ?)
         ON CONFLICT (key) DO NOTHING`,
        [nowIso()]
      );
    }
    const inProgress = await tx.all(
      "SELECT group_no FROM teams WHERE status = 'IN_PROGRESS'"
    );
    return { alreadyFrozen: already, groupNos: inProgress.map((r) => r.group_no) };
  });
}

// ---- 六、換隊長機制 ----

async function requestLeaderTransfer(groupNo, requesterUserId) {
  return transaction(async (tx) => {
    const team = await findTeam(tx, groupNo);
    if (!team) {
      return { reply: [textMsg(`⚠️ 第 ${groupNo} 組尚無人報到，無法接任隊長。`)] };
    }
    const member = await findMembership(tx, requesterUserId);
    if (!member || member.group_no !== groupNo) {
      return {
        reply: [textMsg(`⚠️ 您並非第 ${groupNo} 組成員，請先以組員身分完成報到。`)],
      };
    }
    if (member.role === "LEADER") {
      return { reply: [textMsg("👑 您已經是本組隊長囉。")] };
    }

    const ts = nowIso();
    await tx.run(
      `INSERT INTO leader_transfer_requests (group_no, requester_user_id, requested_at, status)
       VALUES (?, ?, ?, 'PENDING')`,
      [groupNo, requesterUserId, ts]
    );

    const adminMessages = [
      textMsg(
        `📣 換隊長請求：第 ${groupNo} 組\n請小編輸入「確認換隊長 ${groupNo}組」核准。`
      ),
    ];
    const adminPushes = getAdminIds().map((adminId) => ({
      to: adminId,
      messages: adminMessages,
    }));

    return {
      reply: [textMsg("📨 已送出接任隊長申請，請等待小編確認。")],
      pushes: adminPushes,
    };
  });
}

async function confirmLeaderTransfer(groupNo) {
  return transaction(async (tx) => {
    const team = await findTeam(tx, groupNo);
    if (!team) return [textMsg(`⚠️ 第 ${groupNo} 組尚無人報到。`)];

    const pending = await tx.all(
      `SELECT * FROM leader_transfer_requests WHERE group_no = ? AND status = 'PENDING' ORDER BY id DESC`,
      [groupNo]
    );

    if (pending.length === 0) {
      return [textMsg(`⚠️ 目前沒有第 ${groupNo} 組的換隊長申請。`)];
    }

    const latest = pending[0];
    const oldLeaderId = team.leader_user_id;

    await tx.run(`UPDATE team_members SET role = 'MEMBER' WHERE user_id = ?`, [
      oldLeaderId,
    ]);
    await tx.run(`UPDATE team_members SET role = 'LEADER' WHERE user_id = ?`, [
      latest.requester_user_id,
    ]);
    await tx.run(`UPDATE teams SET leader_user_id = ? WHERE group_no = ?`, [
      latest.requester_user_id,
      groupNo,
    ]);
    await tx.run(
      `UPDATE leader_transfer_requests SET status = 'APPROVED' WHERE id = ?`,
      [latest.id]
    );
    await tx.run(
      `UPDATE leader_transfer_requests SET status = 'SUPERSEDED' WHERE group_no = ? AND status = 'PENDING'`,
      [groupNo]
    );

    return [textMsg(`✅ 已將第 ${groupNo} 組隊長更換完成。`)];
  });
}

// ---- 七、誤綁組別修正 ----

async function unbindGroup(groupNo) {
  const memberIds = await getGroupMemberIds(groupNo);
  const result = await unbindGroupInTransaction(groupNo);
  void syncRoleMenus(memberIds); // 解除綁定的人換回預設選單（有「報到」按鈕）
  return result;
}

async function unbindGroupInTransaction(groupNo) {
  return transaction(async (tx) => {
    await tx.run("DELETE FROM team_members WHERE group_no = ?", [groupNo]);
    await tx.run("DELETE FROM checkpoint_log WHERE group_no = ?", [groupNo]);
    await tx.run("DELETE FROM leader_transfer_requests WHERE group_no = ?", [
      groupNo,
    ]);
    await tx.run("DELETE FROM teams WHERE group_no = ?", [groupNo]);
    await submissionStore.deleteSubmissionsForGroup(groupNo);
    return [
      textMsg(`♻️ 已清空第 ${groupNo} 組所有綁定帳號與報到狀態，可重新報到。`),
    ];
  });
}

// ---- 七之二、小編手動加分／扣分（任意時機、任意理由，例如額外任務、表現優異、犯規扣分）----
// 加分會直接影響排行榜排序（見 buildRanking），視同多完成幾關的效果；點數可以是負數（扣分）。

async function addBonusPoints(groupNo, points, reason, awardedByUserId) {
  return transaction(async (tx) => {
    const team = await findTeam(tx, groupNo);
    if (!team) {
      return [textMsg(`⚠️ 第 ${groupNo} 組尚未有任何成員報到，無法加分。`)];
    }
    await tx.run("UPDATE teams SET bonus_points = bonus_points + ? WHERE group_no = ?", [
      points,
      groupNo,
    ]);
    await tx.run(
      `INSERT INTO bonus_log (group_no, points, reason, awarded_by, awarded_at)
       VALUES (?, ?, ?, ?, ?)`,
      [groupNo, points, reason || null, awardedByUserId, nowIso()]
    );
    const updated = await findTeam(tx, groupNo);
    const verb = points >= 0 ? "加分" : "扣分";
    const reasonText = reason ? `（理由：${reason}）` : "";
    return [
      textMsg(
        `✅ 已為第 ${groupNo} 組${verb} ${Math.abs(points)} 分${reasonText}，目前累計加分：${updated.bonus_points}`
      ),
    ];
  });
}

// 給後台網頁看每一筆加分／扣分紀錄的明細（誰、何時、加了多少、理由），awardedBy 只顯示 userId 末 6 碼
async function listBonusLog() {
  const rows = await db.all(
    "SELECT group_no, points, reason, awarded_by, awarded_at FROM bonus_log ORDER BY awarded_at DESC"
  );
  return rows.map((r) => ({
    groupNo: r.group_no,
    points: r.points,
    reason: r.reason,
    awardedBySuffix: r.awarded_by.slice(-6),
    awardedAt: r.awarded_at,
  }));
}

// ---- 七之三、緊急聯絡 ----
// 任何人（隊員、關主、總領隊、還沒報到的帳號）傳「緊急聯絡」，立刻推播給所有小編，並留一筆紀錄。
// 小編按訊息底下的「我來處理」（＝輸入「處理緊急 N」）或後台按「已處理」後，會回頭通知回報者。

const EMERGENCY_REPEAT_WINDOW_MS = 60 * 1000; // 同一個人 60 秒內重複按，不再重複推播，避免洗版
const EMERGENCY_MERGE_WINDOW_MS = 30 * 60 * 1000; // 30 分鐘內還沒處理的，後續補充都算同一件

// 個人專屬圖文選單：身分（小隊／關主／總領隊／小編）改變時通知外層去換選單。
// 跟 profileResolver 一樣由 src/index.js 啟動時注入（teamService 不碰 LINE API，測試也不會打到網路）。
let roleMenuHook = null;
function setRoleMenuHook(fn) {
  roleMenuHook = fn;
}

// 這個人目前該用哪一套選單（優先順序：小編 > 總領隊 > 關主 > 小隊），都不是回傳 null＝預設選單
async function menuRoleOf(userId) {
  if (getAdminIds().includes(userId)) return "admin";
  if (await isBroadcaster(userId)) return "broadcaster";
  if (await getRefereeCheckpoint(userId)) return "referee";
  if (await findMembership(db, userId)) return "team";
  return null;
}

// 身分改變後呼叫：重新判斷該用哪套選單並通知外層。背景執行、失敗只記 log，不影響指令回覆。
function syncRoleMenu(userId, { skipIfNone = false } = {}) {
  if (!roleMenuHook) return Promise.resolve();
  return menuRoleOf(userId)
    .then((role) => (role === null && skipIfNone ? undefined : roleMenuHook(userId, role)))
    .catch((err) => console.error(`套用 ${userId.slice(-6)} 的專屬選單失敗（不影響指令）：`, err.message || err));
}

// 全部重新套用一次：重新上傳選單、或伺服器重啟後用。所有隊伍成員、關主、總領隊、小編都會確認選單是對的。
async function syncAllRoleMenus() {
  if (roleMenuHook && roleMenuHook.refresh) await roleMenuHook.refresh();
  const rows = await db.all(
    `SELECT user_id FROM team_members UNION SELECT user_id FROM referees UNION SELECT user_id FROM broadcasters`
  );
  const ids = new Set([...rows.map((r) => r.user_id), ...getAdminIds()]);
  for (const id of ids) await syncRoleMenu(id, { skipIfNone: true });
  return ids.size;
}

// 批次（重置／解除綁定）：先記下受影響的人，資料改完再逐一同步
async function syncRoleMenus(userIds) {
  for (const id of userIds) await syncRoleMenu(id);
}

// 查 LINE 顯示名稱用：由 src/index.js 啟動時注入（teamService 本身不碰 LINE API，測試也不會打到網路）
let profileResolver = null;
function setProfileResolver(fn) {
  profileResolver = fn;
}

async function lookupDisplayName(userId) {
  if (!profileResolver) return null;
  try {
    return (await profileResolver(userId)) || null;
  } catch (err) {
    console.error("查詢 LINE 顯示名稱失敗（不影響緊急聯絡）：", err);
    return null;
  }
}

function taipeiTime(iso) {
  return new Date(iso).toLocaleTimeString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function checkpointNameOf(checkpointId) {
  try {
    return getCheckpoint(checkpointId).name;
  } catch {
    return checkpointId;
  }
}

function checkpointLabelOf(checkpointId) {
  try {
    return `${checkpointId}「${getCheckpoint(checkpointId).name}」`;
  } catch {
    return checkpointId;
  }
}

// 回報者是誰、人在哪一關，讓小編一看就知道要去哪裡、找誰
async function describeReporter(userId) {
  const identities = [];
  let groupNo = null;
  let checkpointLabel = null;

  const member = await findMembership(db, userId);
  if (member) {
    groupNo = member.group_no;
    identities.push(`第 ${member.group_no} 組${member.role === "LEADER" ? "隊長" : "組員"}`);
    const team = await findTeam(db, member.group_no);
    if (team && team.status === "CHECKED_IN") {
      checkpointLabel = "尚未出發";
    } else if (team && team.status === "FINISHED") {
      checkpointLabel = "已完成終點確認";
    } else if (team) {
      const route = getRoute(team.group_no);
      const current = route[team.current_index];
      if (current) checkpointLabel = checkpointLabelOf(current.checkpointId);
    }
  }
  const refereeCheckpoint = await getRefereeCheckpoint(userId);
  if (refereeCheckpoint) {
    const label = checkpointLabelOf(refereeCheckpoint);
    identities.push(`${label}關主`);
    if (!checkpointLabel) checkpointLabel = label;
  }
  if (await isBroadcaster(userId)) identities.push("總領隊");
  if (getAdminIds().includes(userId)) identities.push("小編");
  if (identities.length === 0) identities.push("尚未報到的帳號");

  return { groupNo, identityLabel: identities.join("＋"), checkpointLabel };
}

function emergencyAdminMessage(row, kind) {
  const title =
    kind === "supplement"
      ? `📝 緊急聯絡 #${row.id} 補充說明`
      : kind === "reminder"
        ? `🔔 緊急聯絡 #${row.id} 再次提醒（尚未有人處理）`
        : `🚨🚨 緊急聯絡 #${row.id} 🚨🚨`;
  const who = row.display_name ? `${row.display_name}（${row.identity_label}）` : row.identity_label;
  const lines = [title, `👤 ${who}`];
  if (row.checkpoint_label) lines.push(`📍 目前關卡：${row.checkpoint_label}`);
  lines.push(`💬 說明：${row.detail || "（尚未說明，請儘快聯繫對方確認狀況）"}`);
  lines.push(`🆔 ...${row.user_id.slice(-6)}　🕒 ${taipeiTime(row.last_alerted_at)}`);
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (base) lines.push(`👉 ${base}/admin#emergencies`);
  return {
    ...textMsg(lines.join("\n")),
    quickReply: {
      items: [
        {
          type: "action",
          action: { type: "message", label: `🙋 我來處理 #${row.id}`, text: `處理緊急 ${row.id}` },
        },
      ],
    },
  };
}

function emergencyReporterReply(detailGiven) {
  const phone = (process.env.EMERGENCY_PHONE || "").trim();
  const lines = [
    "🚨 已通知小編！請留在安全的地方、保持手機暢通，小編會盡快與您聯繫。",
    detailGiven
      ? "📝 您補充的說明已一併轉給小編。"
      : "📝 想補充狀況（例如受傷、迷路、所在位置），請輸入「緊急聯絡 說明內容」。",
  ];
  if (phone) lines.push(`📞 情況危急請直接撥打：${phone}`);
  return textMsg(lines.join("\n"));
}

async function reportEmergency(userId, detail = "") {
  const text = String(detail || "").trim();
  const adminIds = getAdminIds();
  const pushToAdmins = (row, kind) => {
    const messages = [emergencyAdminMessage(row, kind)];
    return adminIds.map((adminId) => ({ to: adminId, messages }));
  };
  const noAdminWarning = adminIds.length === 0
    ? [textMsg("⚠️ 系統目前沒有設定小編帳號，訊息無法即時送達，請直接聯繫現場工作人員！")]
    : [];

  const now = new Date();
  const existing = await db.get(
    "SELECT * FROM emergencies WHERE user_id = ? AND status = 'OPEN' ORDER BY id DESC LIMIT 1",
    [userId]
  );
  const stillOpen =
    existing && now.getTime() - new Date(existing.created_at).getTime() < EMERGENCY_MERGE_WINDOW_MS;

  if (stillOpen) {
    if (text) {
      const merged = existing.detail ? `${existing.detail}\n${text}` : text;
      await db.run("UPDATE emergencies SET detail = ?, last_alerted_at = ? WHERE id = ?", [
        merged,
        now.toISOString(),
        existing.id,
      ]);
      const row = { ...existing, detail: text, last_alerted_at: now.toISOString() };
      return {
        reply: [emergencyReporterReply(true), ...noAdminWarning],
        directPushes: pushToAdmins(row, "supplement"),
      };
    }
    if (now.getTime() - new Date(existing.last_alerted_at).getTime() < EMERGENCY_REPEAT_WINDOW_MS) {
      return {
        reply: [
          textMsg(
            "🚨 您剛剛已送出緊急聯絡，小編已收到，請稍候、保持手機暢通。\n📝 想補充狀況請輸入「緊急聯絡 說明內容」。"
          ),
        ],
        directPushes: [],
      };
    }
    await db.run("UPDATE emergencies SET last_alerted_at = ? WHERE id = ?", [
      now.toISOString(),
      existing.id,
    ]);
    const row = { ...existing, last_alerted_at: now.toISOString() };
    return {
      reply: [emergencyReporterReply(false), ...noAdminWarning],
      directPushes: pushToAdmins(row, "reminder"),
    };
  }

  const displayName = await lookupDisplayName(userId);
  const who = await describeReporter(userId);
  const ts = now.toISOString();
  const inserted = await db.get(
    `INSERT INTO emergencies
       (user_id, display_name, group_no, identity_label, checkpoint_label, detail, status, created_at, last_alerted_at)
     VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?) RETURNING *`,
    [userId, displayName, who.groupNo, who.identityLabel, who.checkpointLabel, text || null, ts, ts]
  );
  return {
    reply: [emergencyReporterReply(!!text), ...noAdminWarning],
    directPushes: pushToAdmins(inserted, "new"),
  };
}

// 小編接手：LINE 指令「處理緊急 N」與後台按鈕共用。回覆回報者一則安心訊息，並告知其他小編已有人處理，避免重複跑去。
async function handleEmergency(emergencyId, handledBy) {
  const row = await db.get("SELECT * FROM emergencies WHERE id = ?", [emergencyId]);
  if (!row) return { reply: [textMsg(`⚠️ 找不到緊急聯絡 #${emergencyId}，可能已被遊戲重置清除。`)], directPushes: [] };
  if (row.status === "HANDLED") {
    return { reply: [textMsg(`ℹ️ 緊急聯絡 #${emergencyId} 已經有人接手處理囉。`)], directPushes: [] };
  }
  await db.run(
    "UPDATE emergencies SET status = 'HANDLED', handled_by = ?, handled_at = ? WHERE id = ?",
    [handledBy, nowIso(), emergencyId]
  );
  const who = row.display_name ? `${row.display_name}（${row.identity_label}）` : row.identity_label;
  const directPushes = [
    {
      to: row.user_id,
      messages: [textMsg("✅ 小編已收到您的緊急聯絡，正在處理中，請留在原地、保持手機暢通。")],
    },
  ];
  for (const adminId of getAdminIds()) {
    if (adminId === handledBy) continue;
    directPushes.push({
      to: adminId,
      messages: [textMsg(`ℹ️ 緊急聯絡 #${emergencyId}（${who}）已有小編接手處理，不用重複前往。`)],
    });
  }
  return {
    reply: [textMsg(`✅ 已標記緊急聯絡 #${emergencyId}（${who}）由您處理，並已通知回報者。`)],
    directPushes,
  };
}

// 給後台網頁：未處理的排前面，其次新的在前；userId 只給末 6 碼
async function listEmergencies() {
  const rows = await db.all(
    `SELECT * FROM emergencies
     ORDER BY CASE WHEN status = 'OPEN' THEN 0 ELSE 1 END, created_at DESC`
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    userIdSuffix: r.user_id.slice(-6),
    groupNo: r.group_no,
    identityLabel: r.identity_label,
    checkpointLabel: r.checkpoint_label,
    detail: r.detail,
    status: r.status,
    createdAt: r.created_at,
    lastAlertedAt: r.last_alerted_at,
    handledAt: r.handled_at,
  }));
}

async function countOpenEmergencies() {
  const row = await db.get("SELECT COUNT(*) AS n FROM emergencies WHERE status = 'OPEN'");
  return Number(row.n);
}

// ---- 八、重置整場遊戲（小編用，非文件原始條款，供活動前彩排／正式開賽前重置）----

async function resetGame() {
  const memberIds = (await db.all("SELECT user_id FROM team_members")).map((r) => r.user_id);
  const result = await resetGameInTransaction();
  void syncRoleMenus(memberIds); // 所有隊伍成員換回預設選單
  return result;
}

async function resetGameInTransaction() {
  return transaction(async (tx) => {
    await tx.run("DELETE FROM checkpoint_log");
    await tx.run("DELETE FROM leader_transfer_requests");
    await tx.run("DELETE FROM team_members");
    await tx.run("DELETE FROM teams");
    await tx.run("DELETE FROM settings");
    await tx.run("DELETE FROM bonus_log");
    await tx.run("DELETE FROM pending_submissions");
    await tx.run("DELETE FROM emergencies");
    return [textMsg("♻️ 已重置整場遊戲，所有組別的報到、進度與紀錄皆已清空。")];
  });
}

// ---- 九、查詢類（唯讀，直接用連線池，不需要交易）----

async function queryCurrentCheckpoint(userId) {
  const { error, team } = await requireMembership(db, userId);
  if (error) return error;

  if (team.status === "CHECKED_IN") {
    return [textMsg("⏳ 尚未出發，請等待關主宣布出發。")];
  }
  if (team.status === "FINISHED") {
    const elapsed = formatElapsed(team.start_time, team.finish_time);
    return [
      textMsg(
        `🏁 貴隊已完成終點確認。\n完成關卡數：${team.current_index}/${event.totalCheckpoints}\n總耗時：${elapsed}`
      ),
    ];
  }

  const route = getRoute(team.group_no);
  if (team.current_index >= route.length) {
    return [textMsg(`🎉 貴隊已完成全部 ${route.length} 關，請儘速前往 B6 辦理終點確認！`)];
  }
  const current = route[team.current_index];
  return checkpointAnnouncement(current.checkpointId);
}

async function queryProgress(userId) {
  const { error, team } = await requireMembership(db, userId);
  if (error) return error;

  if (team.status === "CHECKED_IN") {
    return [textMsg("⏳ 尚未出發。")];
  }
  if (team.status === "FINISHED") {
    const elapsed = formatElapsed(team.start_time, team.finish_time);
    return [
      textMsg(
        `🏁 已完成 ${team.current_index}/${event.totalCheckpoints} 關\n總耗時：${elapsed}（已終點確認）`
      ),
    ];
  }
  const elapsed = formatElapsed(team.start_time, nowIso());
  const frozen = await isProgressFrozen(db);
  const note = frozen ? "\n（已停止新增關卡進度，請儘速前往 B6 辦理終點確認）" : "";
  return [
    textMsg(
      `🚶 已完成 ${team.current_index}/${event.totalCheckpoints} 關\n累計耗時（尚未歸隊）：${elapsed}${note}`
    ),
  ];
}

async function adminListProgress() {
  const teams = await Promise.all(
    getAllGroupNos().map((groupNo) => findTeam(db, groupNo))
  );
  const lines = getAllGroupNos().map((groupNo, i) => {
    const team = teams[i];
    if (!team) return `${groupNo}組｜尚未報到`;
    const bonusText = team.bonus_points ? `｜加分 ${team.bonus_points > 0 ? "+" : ""}${team.bonus_points}` : "";
    if (team.status === "CHECKED_IN") return `${groupNo}組｜已報到／待出發${bonusText}`;
    if (team.status === "FINISHED") {
      const elapsed = formatElapsed(team.start_time, team.finish_time);
      const tag = team.is_late ? "逾時" : "準時";
      return `${groupNo}組｜已終點確認（${tag}）｜${team.current_index}/${event.totalCheckpoints}｜${elapsed}${bonusText}`;
    }
    const elapsed = formatElapsed(team.start_time, nowIso());
    return `${groupNo}組｜闖關中｜${team.current_index}/${event.totalCheckpoints}｜${elapsed}（${taipeiTime(team.start_time)} 出發）${bonusText}`;
  });
  return [textMsg(`📋 目前進度\n${lines.join("\n")}`)];
}

// 關主專用的「進度」查詢：這一關的「預定來訪順序」——照路線設定排（先排第幾關會走到這裡，同一關再依組別號碼），
// 每一組後面標上目前實際進度，關主一眼就能核對「該來的來了沒」。只列路線有經過這關的組別，
// 不顯示其他關卡的細節。
// 注意：系統沒有「實際抵達」的感應，「已抵達」是指這組已經輪到這關（上一關通過、還沒通過這關），實際位置以現場為準。
const CIRCLED_NUMBERS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
function orderMark(n) {
  return n >= 1 && n <= CIRCLED_NUMBERS.length ? CIRCLED_NUMBERS[n - 1] : `${n}.`;
}

async function refereeListProgress(checkpointId) {
  const cp = getCheckpoint(checkpointId);
  const groupNos = getAllGroupNos();
  const teams = await Promise.all(groupNos.map((groupNo) => findTeam(db, groupNo)));
  const passedRows = await db.all("SELECT group_no, passed_at FROM checkpoint_log WHERE checkpoint_id = ?", [
    checkpointId,
  ]);
  const passedAtByGroup = new Map(passedRows.map((r) => [r.group_no, r.passed_at]));

  const planned = [];
  for (let i = 0; i < groupNos.length; i++) {
    const idx = getRoute(groupNos[i]).findIndex((s) => s.checkpointId === checkpointId);
    if (idx !== -1) planned.push({ groupNo: groupNos[i], idx, team: teams[i] });
  }
  planned.sort((a, b) => a.idx - b.idx || a.groupNo - b.groupNo);
  if (planned.length === 0) {
    return [textMsg(`📋 ${cp.id}｜${cp.name}\n目前的路線設定裡沒有任何組別會經過這一關。`)];
  }

  const waitingGroups = [];
  const lines = planned.map(({ groupNo, idx, team }, i) => {
    let status;
    if (passedAtByGroup.has(groupNo)) {
      status = `✅ 已通過（${taipeiTime(passedAtByGroup.get(groupNo))}）`;
    } else if (!team) {
      status = "⏳ 尚未報到";
    } else if (team.status === "CHECKED_IN") {
      status = "⏳ 尚未出發";
    } else if (team.status === "FINISHED") {
      status = "🏁 已結束";
    } else if (team.current_index === idx) {
      status = "✋ 已抵達，等待確認";
      waitingGroups.push(groupNo);
    } else {
      status = `🚶 已出發，還在路上（還差 ${idx - team.current_index} 關）`;
    }
    return `${orderMark(i + 1)} ${groupNo}組（第 ${idx + 1} 關）｜${status}`;
  });

  const out = [`📋 ${cp.id}｜${cp.name}｜預定來訪順序`, "（依路線設定排列，括號是該組的第幾關）", ""];
  if (waitingGroups.length > 0) {
    out.push(`👉 現在等您確認：${waitingGroups.map((g) => `${g}組`).join("、")}（確認完成後點下方按鈕通過）`, "");
  }
  out.push(...lines);
  // 只對「已輪到這關、等待確認」的組別附一鍵通過按鈕：關主是看完清單、確認任務完成才點，比推播上的按鈕不容易按錯
  const message = textMsg(out.join("\n"));
  if (waitingGroups.length > 0) message.quickReply = approveQuickReply(waitingGroups);
  return [message];
}

// 小編也能查某一關的來訪順序（關主是用自己登記的那關），輸入關卡代號或名稱
async function adminCheckpointOrder(text) {
  const cp = findCheckpointByIdOrName(text || "");
  if (!cp) {
    return [textMsg("🔎 請指定關卡代號或名稱，例如「順序 B3」或「順序 救救菜英文」。")];
  }
  return refereeListProgress(cp.id);
}

// 給後台網頁用的 JSON 版進度快照（跟 adminListProgress 同一份資料，只是格式給網頁用而不是 LINE 文字）
async function getProgressSnapshot() {
  const groupNos = getAllGroupNos();
  const teams = await Promise.all(groupNos.map((groupNo) => findTeam(db, groupNo)));
  return groupNos.map((groupNo, i) => {
    const team = teams[i];
    if (!team) {
      return { groupNo, status: "NOT_CHECKED_IN" };
    }
    const base = {
      groupNo,
      status: team.status,
      currentIndex: team.current_index,
      totalCheckpoints: event.totalCheckpoints,
      startTime: team.start_time,
      bonusPoints: team.bonus_points || 0,
    };
    if (team.status === "FINISHED") {
      return {
        ...base,
        finishTime: team.finish_time,
        isLate: !!team.is_late,
        elapsed: formatElapsed(team.start_time, team.finish_time),
      };
    }
    if (team.status === "IN_PROGRESS") {
      // 目前這一關（給後台進度表顯示與「通過」按鈕確認用）；已走完全部關卡則沒有
      const step = getRoute(groupNo)[team.current_index];
      const current = step ? { currentCheckpointId: step.checkpointId, currentCheckpointName: checkpointNameOf(step.checkpointId) } : {};
      return { ...base, ...current, elapsed: formatElapsed(team.start_time, nowIso()) };
    }
    return base; // CHECKED_IN
  });
}

// ---- 十、排行榜 ----

async function isRankingPublic() {
  const row = await db.get(
    "SELECT value FROM settings WHERE key = 'ranking_public'"
  );
  return row ? row.value === "1" : false; // 預設關閉，需小編主動開啟
}

async function setRankingPublic(isPublic) {
  await db.run(
    `INSERT INTO settings (key, value) VALUES ('ranking_public', ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [isPublic ? "1" : "0"]
  );
}

// 對應架構文件 v2「十二、排名規則」：
// 1. 是否準時完成終點確認（準時 > 逾時或尚未歸隊；準時＝出發後 event.maxDurationMinutes 內，見 timeUtil.isLate）
// 2. 完成關卡數多者排前面（小編手動加分視同多完成幾關，直接併入這一項比較）
// 3. 總耗時短者排前面；尚未完成終點確認者無總耗時可比，並列於同關卡數的最後
function bucketOf(team) {
  return team.status === "FINISHED" && !team.is_late ? 0 : 1;
}

function effectiveProgress(team) {
  return team.current_index + (team.bonus_points || 0);
}

async function buildRanking() {
  const teams = (
    await Promise.all(getAllGroupNos().map((groupNo) => findTeam(db, groupNo)))
  ).filter(Boolean);

  const enriched = teams.map((team) => {
    const hasFinishTime = team.status === "FINISHED";
    const elapsedSec = hasFinishTime
      ? Math.floor(
          (new Date(team.finish_time).getTime() - new Date(team.start_time).getTime()) /
            1000
        )
      : Infinity;
    return { team, hasFinishTime, elapsedSec };
  });

  enriched.sort((a, b) => {
    const bucketDiff = bucketOf(a.team) - bucketOf(b.team);
    if (bucketDiff !== 0) return bucketDiff;
    const progressDiff = effectiveProgress(b.team) - effectiveProgress(a.team);
    if (progressDiff !== 0) return progressDiff;
    if (a.hasFinishTime !== b.hasFinishTime) {
      return a.hasFinishTime ? -1 : 1; // 有總耗時（曾終點確認）者排在同關卡數的前面
    }
    return a.elapsedSec - b.elapsedSec;
  });

  return enriched;
}

async function formatRanking() {
  const ranked = await buildRanking();
  const medals = ["🥇", "🥈", "🥉"];
  const lines = ranked.map(({ team }, i) => {
    const rankIcon = medals[i] || `${i + 1}.`;
    const bonusText = team.bonus_points ? `｜加分 ${team.bonus_points > 0 ? "+" : ""}${team.bonus_points}` : "";
    if (team.status === "CHECKED_IN") {
      return `${rankIcon} ${team.group_no}組｜尚未出發${bonusText}`;
    }
    if (team.status === "FINISHED") {
      const elapsed = formatElapsed(team.start_time, team.finish_time);
      const tag = team.is_late ? "（逾時）" : "（準時）";
      return `${rankIcon} ${team.group_no}組｜${team.current_index}/${event.totalCheckpoints}｜${elapsed}${tag}${bonusText}`;
    }
    const elapsed = formatElapsed(team.start_time, nowIso());
    return `${rankIcon} ${team.group_no}組｜${team.current_index}/${event.totalCheckpoints}｜目前耗時 ${elapsed}（未歸隊）${bonusText}`;
  });
  return [textMsg(`🏆 排行榜\n${lines.join("\n")}`)];
}

module.exports = {
  checkin,
  depart,
  verifyKeyword,
  submitMedia,
  approveCheckpoint,
  listPendingSubmissions,
  approveSubmissionById,
  registerReferee,
  assignReferee,
  removeReferee,
  assignBroadcaster,
  removeBroadcaster,
  listLineUsers,
  adminRoleCommand,
  usageGuideFor,
  tryRefereeBareRegistration,
  getRefereeCheckpoint,
  resetReferees,
  listReferees,
  listTeamLeaders,
  registerBroadcaster,
  isBroadcaster,
  resetBroadcasters,
  listBroadcasters,
  broadcastMessage,
  countBroadcastRecipients,
  BROADCAST_TARGET_LABELS,
  revertLastCheckpoint,
  cancelFinish,
  finishAtB6,
  freezeProgress,
  requestLeaderTransfer,
  confirmLeaderTransfer,
  unbindGroup,
  addBonusPoints,
  listBonusLog,
  reportEmergency,
  handleEmergency,
  listEmergencies,
  countOpenEmergencies,
  setProfileResolver,
  setRoleMenuHook,
  syncRoleMenu,
  syncRoleMenus,
  syncAllRoleMenus,
  menuRoleOf,
  resetGame,
  queryCurrentCheckpoint,
  queryProgress,
  adminListProgress,
  refereeListProgress,
  adminCheckpointOrder,
  getProgressSnapshot,
  isRankingPublic,
  setRankingPublic,
  formatRanking,
  findMembership: (userId) => findMembership(db, userId),
  findTeam: (groupNo) => findTeam(db, groupNo),
  getGroupMemberIds,
  getGroupBroadcastRecipientIds,
  textMsg,
};
