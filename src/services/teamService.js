const { db, transaction } = require("../db");
const { getCheckpoint } = require("../config/checkpoints");
const { getRoute, getAllGroupNos } = require("../config/teamsRoute");
const { getAdminIds } = require("../config/admins");
const { nowIso, formatElapsed, isLate } = require("./timeUtil");
const event = require("../config/event");

function textMsg(text) {
  return { type: "text", text };
}

function mapUrl(mapFile) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  return `${base}/maps/${mapFile}`;
}

function imageMsg(mapFile) {
  const url = mapUrl(mapFile);
  return { type: "image", originalContentUrl: url, previewImageUrl: url };
}

function checkpointAnnouncement(checkpointId, { isFirst = false } = {}) {
  const cp = getCheckpoint(checkpointId);
  const heading = isFirst
    ? `📍 請先移動到 ${cp.id}（${cp.name}）`
    : `🧭 請移動到 ${cp.id}（${cp.name}）`;
  const body =
    `${heading}\n\n` +
    `📍 地點：${cp.location}\n` +
    `🎮 玩法：${cp.content}\n` +
    `✅ 過關方式：${cp.scoringMethod}`;
  const messages = [textMsg(body)];
  for (const mapFile of cp.mapFiles || []) {
    messages.push(imageMsg(mapFile));
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
  if (!member) return { error: [textMsg("請先報到（輸入「報到 X組」，X 為您的組別編號）")] };
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

// 12:30 或小編「遊戲結束」之後，系統停止受理新的關卡進度（見 freezeProgress）
async function isProgressFrozen(exec) {
  const row = await exec.get(
    "SELECT value FROM settings WHERE key = 'progress_frozen_at'"
  );
  return !!row;
}

// ---- 一、報到 ----

async function checkin(groupNo, userId) {
  if (!getAllGroupNos().includes(groupNo)) {
    return [textMsg(`第 ${groupNo} 組不存在，請確認組別編號是否正確（1～${getAllGroupNos().length}）。`)];
  }
  return transaction(async (tx) => {
    const existing = await findMembership(tx, userId);
    if (existing) {
      if (existing.group_no === groupNo) {
        return [textMsg(`您已完成第 ${groupNo} 組報到，請等待關主宣布出發。`)];
      }
      return [
        textMsg(
          `您先前已綁定為第 ${existing.group_no} 組，如需更正組別請聯繫小編協助「解除綁定」。`
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
      ];
    }

    await tx.run(
      `INSERT INTO team_members (user_id, group_no, role, joined_at) VALUES (?, ?, 'MEMBER', ?)`,
      [userId, groupNo, ts]
    );
    return [
      textMsg(`✅ 報到成功！您已加入第 ${groupNo} 組（組員身分）。\n請等待關主宣布出發。`),
    ];
  });
}

// ---- 二、出發（現場關主觸發）----

async function depart(groupNo) {
  return transaction(async (tx) => {
    const team = await findTeam(tx, groupNo);
    if (!team) {
      return { reply: [textMsg(`第 ${groupNo} 組尚未有任何成員報到，無法出發。`)] };
    }
    if (team.status === "IN_PROGRESS") {
      return { reply: [textMsg(`第 ${groupNo} 組已經出發過了，正在闖關中。`)] };
    }
    if (team.status === "FINISHED") {
      return { reply: [textMsg(`第 ${groupNo} 組已經辦理終點確認，無法再次出發。`)] };
    }

    const route = getRoute(groupNo);
    const ts = nowIso();
    await tx.run(
      `UPDATE teams SET status = 'IN_PROGRESS', start_time = ?, current_index = 0 WHERE group_no = ?`,
      [ts, groupNo]
    );

    const announcement = checkpointAnnouncement(route[0].checkpointId, { isFirst: true });
    const teamMessages = [textMsg(`🚩 第 ${groupNo} 組出發！開始計時。`), ...announcement];

    return {
      reply: [textMsg(`已將第 ${groupNo} 組標記為出發。`)],
      groupBroadcast: { groupNo, messages: teamMessages },
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
    return { blocked: [textMsg("尚未出發，請等待關主宣布出發。")] };
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

// 實際過關：寫紀錄、往下一關前進，回傳「通關確認＋下一關公告」的訊息陣列
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

  const confirm = textMsg(`✅ 通關：${cp.name}`);

  if (newIndex >= route.length) {
    return [
      confirm,
      textMsg(`🎉 恭喜完成所有 ${route.length} 關！請儘速前往 B6 辦理終點確認。`),
    ];
  }

  const next = route[newIndex];
  return [confirm, ...checkpointAnnouncement(next.checkpointId)];
}

// ---- 三之一、有關主的 6 關：關鍵字比對正確後立即過關 ----

async function verifyKeyword(userId, text) {
  return transaction(async (tx) => {
    const guard = await checkAttemptGuards(tx, userId);
    if (guard.blocked !== undefined) return guard.blocked;
    const { team, route, expected, cp } = guard;

    if (cp.verifyType === "referee") {
      return [
        textMsg("這一關由關主現場確認完成，不需要輸入任何文字，請等待關主或小編為您解鎖下一關。"),
      ];
    }
    if (cp.verifyType !== "keyword") {
      const kind = cp.verifyType === "video" ? "影片" : "照片";
      return [textMsg(`這一關沒有現場關主，請直接上傳${kind}，不需要輸入文字關鍵字。`)];
    }
    if (text !== expected.keyword) {
      return [textMsg("❌ 不正確，請向關主確認。")];
    }

    return advanceCheckpoint(tx, team, expected, cp, route);
  });
}

// ---- 三之二、無關主的 6 關：上傳照片／影片後先送審，小編「通過 X組」才真正過關 ----

async function submitMedia(userId) {
  return transaction(async (tx) => {
    const guard = await checkAttemptGuards(tx, userId);
    if (guard.blocked !== undefined) return { reply: guard.blocked, adminNotify: [] };
    const { team, cp } = guard;

    if (cp.verifyType === "referee") {
      return {
        reply: [
          textMsg(
            "這一關由關主現場確認完成，不需要上傳照片或影片，請等待關主或小編為您解鎖下一關。"
          ),
        ],
        adminNotify: [],
      };
    }
    if (cp.verifyType === "keyword") {
      return {
        reply: [textMsg("這一關需要向關主取得關鍵字才能過關，請直接輸入文字關鍵字。")],
        adminNotify: [],
      };
    }

    const kind = cp.verifyType === "video" ? "影片" : "照片";
    const adminMessages = [
      textMsg(
        `📸 第 ${team.group_no} 組在「${cp.name}」上傳了${kind}，請至官方帳號聊天記錄確認內容。\n` +
          `確認沒問題請輸入「通過 ${team.group_no}組」解鎖下一關。`
      ),
    ];
    return {
      reply: [textMsg(`已收到您上傳的${kind}，請等待小編確認後解鎖下一關。`)],
      adminNotify: getAdminIds().map((adminId) => ({ to: adminId, messages: adminMessages })),
    };
  });
}

// ---- 三之三、小編手動核准目前這關（適用任何類型：關主關卡或照片／影片關卡）----
// 主要給無關主的 6 關（照片／影片送審後用）；但小編也可以對任何關卡直接喊過，
// 當作「隊伍已回報完成、小編確認即可」的通用捷徑，不限定關卡類型。

async function approveCheckpoint(groupNo) {
  return transaction(async (tx) => {
    const team = await findTeam(tx, groupNo);
    if (!team) {
      return { reply: [textMsg(`第 ${groupNo} 組尚未有任何成員報到。`)] };
    }
    if (team.status === "CHECKED_IN") {
      return { reply: [textMsg(`第 ${groupNo} 組尚未出發。`)] };
    }
    if (team.status === "FINISHED") {
      return { reply: [textMsg(`第 ${groupNo} 組已經辦理終點確認，無需再確認關卡。`)] };
    }

    const route = getRoute(groupNo);
    if (team.current_index >= route.length) {
      return { reply: [textMsg(`第 ${groupNo} 組已完成全部 ${route.length} 關，無需再確認。`)] };
    }

    if (await isProgressFrozen(tx)) {
      return {
        reply: [
          textMsg(
            `已停止受理新的關卡進度，無法再為第 ${groupNo} 組確認關卡（終點確認功能不受影響）。`
          ),
        ],
      };
    }

    const expected = route[team.current_index];
    const cp = getCheckpoint(expected.checkpointId);

    const teamMessages = await advanceCheckpoint(tx, team, expected, cp, route);
    return {
      reply: [textMsg(`已為第 ${groupNo} 組確認「${cp.name}」通過。`)],
      groupBroadcast: { groupNo, messages: teamMessages },
    };
  });
}

// ---- 三之四、退回一關（更正「通過」／「到站」誤觸或手滑重複的情況）----
// 「通過」不是天然冪等的操作（每按一次就前進一關），連按兩次或按錯組別都沒有事前防呆，
// 這裡提供事後更正的方式：FINISHED 就取消終點確認、否則就退回最近一次過的那一關。

async function revertLastCheckpoint(groupNo) {
  return transaction(async (tx) => {
    const team = await findTeam(tx, groupNo);
    if (!team) {
      return { reply: [textMsg(`第 ${groupNo} 組尚未有任何成員報到。`)] };
    }

    if (team.status === "FINISHED") {
      await tx.run(
        `UPDATE teams SET status = 'IN_PROGRESS', finish_time = NULL, is_late = 0 WHERE group_no = ?`,
        [groupNo]
      );
      return {
        reply: [textMsg(`已取消第 ${groupNo} 組的終點確認，該組恢復為闖關中，計時繼續累加。`)],
        groupBroadcast: {
          groupNo,
          messages: [
            textMsg("⚠️ 小編剛剛取消了終點確認，貴隊狀態恢復為闖關中，請留意後續指示。"),
          ],
        },
      };
    }

    if (team.status === "CHECKED_IN" || team.current_index === 0) {
      return { reply: [textMsg(`第 ${groupNo} 組目前沒有可以退回的關卡進度。`)] };
    }

    const newIndex = team.current_index - 1;
    const route = getRoute(groupNo);
    const revertedStep = route[newIndex];
    const cp = getCheckpoint(revertedStep.checkpointId);

    await tx.run(
      `DELETE FROM checkpoint_log WHERE group_no = ? AND checkpoint_index = ?`,
      [groupNo, newIndex]
    );
    await tx.run(`UPDATE teams SET current_index = ? WHERE group_no = ?`, [
      newIndex,
      groupNo,
    ]);

    return {
      reply: [textMsg(`已將第 ${groupNo} 組退回到「${cp.name}」，該關重新視為未完成。`)],
      groupBroadcast: {
        groupNo,
        messages: [
          textMsg(
            `⚠️ 小編剛剛更正了進度：「${cp.name}」重新視為未完成，請重新完成這一關的任務。`
          ),
        ],
      },
    };
  });
}

// ---- 四、B6 終點確認（由 B6 終點工作人員現場觸發，模式同「出發 X組」）----

async function finishAtB6(groupNo) {
  return transaction(async (tx) => {
    const team = await findTeam(tx, groupNo);
    if (!team) {
      return { reply: [textMsg(`第 ${groupNo} 組尚未有任何成員報到，無法辦理終點確認。`)] };
    }
    if (team.status === "CHECKED_IN") {
      return { reply: [textMsg(`第 ${groupNo} 組尚未出發，無法辦理終點確認。`)] };
    }
    if (team.status === "FINISHED") {
      const elapsed = formatElapsed(team.start_time, team.finish_time);
      return {
        reply: [
          textMsg(
            `第 ${groupNo} 組已經辦理過終點確認了。\n完成關卡數：${team.current_index}/${event.totalCheckpoints}\n總耗時：${elapsed}`
          ),
        ],
      };
    }

    const ts = nowIso();
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
          `已為第 ${groupNo} 組辦理終點確認。完成關卡數：${team.current_index}/${event.totalCheckpoints}，總耗時：${elapsed}${late ? "（逾時）" : ""}`
        ),
      ],
      groupBroadcast: { groupNo, messages: teamMessages },
    };
  });
}

// ---- 五、凍結關卡進度（小編「遊戲結束」／12:30 排程共用；不會產生終點確認）----

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
      return { reply: [textMsg(`第 ${groupNo} 組尚無人報到，無法接任隊長。`)] };
    }
    const member = await findMembership(tx, requesterUserId);
    if (!member || member.group_no !== groupNo) {
      return {
        reply: [textMsg(`您並非第 ${groupNo} 組成員，請先以組員身分完成報到。`)],
      };
    }
    if (member.role === "LEADER") {
      return { reply: [textMsg("您已經是本組隊長囉。")] };
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
      reply: [textMsg("已送出接任隊長申請，請等待小編確認。")],
      pushes: adminPushes,
    };
  });
}

async function confirmLeaderTransfer(groupNo) {
  return transaction(async (tx) => {
    const team = await findTeam(tx, groupNo);
    if (!team) return [textMsg(`第 ${groupNo} 組尚無人報到。`)];

    const pending = await tx.all(
      `SELECT * FROM leader_transfer_requests WHERE group_no = ? AND status = 'PENDING' ORDER BY id DESC`,
      [groupNo]
    );

    if (pending.length === 0) {
      return [textMsg(`目前沒有第 ${groupNo} 組的換隊長申請。`)];
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
  return transaction(async (tx) => {
    await tx.run("DELETE FROM team_members WHERE group_no = ?", [groupNo]);
    await tx.run("DELETE FROM checkpoint_log WHERE group_no = ?", [groupNo]);
    await tx.run("DELETE FROM leader_transfer_requests WHERE group_no = ?", [
      groupNo,
    ]);
    await tx.run("DELETE FROM teams WHERE group_no = ?", [groupNo]);
    return [
      textMsg(`已清空第 ${groupNo} 組所有綁定帳號與報到狀態，可重新報到。`),
    ];
  });
}

// ---- 八、重置整場遊戲（小編用，非文件原始條款，供活動前彩排／正式開賽前重置）----

async function resetGame() {
  return transaction(async (tx) => {
    await tx.run("DELETE FROM checkpoint_log");
    await tx.run("DELETE FROM leader_transfer_requests");
    await tx.run("DELETE FROM team_members");
    await tx.run("DELETE FROM teams");
    await tx.run("DELETE FROM settings");
    return [textMsg("♻️ 已重置整場遊戲，所有組別的報到、進度與紀錄皆已清空。")];
  });
}

// ---- 九、查詢類（唯讀，直接用連線池，不需要交易）----

async function queryCurrentCheckpoint(userId) {
  const { error, team } = await requireMembership(db, userId);
  if (error) return error;

  if (team.status === "CHECKED_IN") {
    return [textMsg("尚未出發，請等待關主宣布出發。")];
  }
  if (team.status === "FINISHED") {
    const elapsed = formatElapsed(team.start_time, team.finish_time);
    return [
      textMsg(
        `貴隊已完成終點確認。\n完成關卡數：${team.current_index}/${event.totalCheckpoints}\n總耗時：${elapsed}`
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
    return [textMsg("尚未出發。")];
  }
  if (team.status === "FINISHED") {
    const elapsed = formatElapsed(team.start_time, team.finish_time);
    return [
      textMsg(
        `已完成 ${team.current_index}/${event.totalCheckpoints} 關\n總耗時：${elapsed}（已終點確認）`
      ),
    ];
  }
  const elapsed = formatElapsed(team.start_time, nowIso());
  const frozen = await isProgressFrozen(db);
  const note = frozen ? "\n（已停止新增關卡進度，請儘速前往 B6 辦理終點確認）" : "";
  return [
    textMsg(
      `已完成 ${team.current_index}/${event.totalCheckpoints} 關\n累計耗時（尚未歸隊）：${elapsed}${note}`
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
    if (team.status === "CHECKED_IN") return `${groupNo}組｜已報到／待出發`;
    if (team.status === "FINISHED") {
      const elapsed = formatElapsed(team.start_time, team.finish_time);
      const tag = team.is_late ? "逾時" : "準時";
      return `${groupNo}組｜已終點確認（${tag}）｜${team.current_index}/${event.totalCheckpoints}｜${elapsed}`;
    }
    const elapsed = formatElapsed(team.start_time, nowIso());
    return `${groupNo}組｜闖關中｜${team.current_index}/${event.totalCheckpoints}｜${elapsed}`;
  });
  return [textMsg(`📋 目前進度\n${lines.join("\n")}`)];
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
// 1. 是否於12:30前完成終點確認（準時 > 逾時或尚未歸隊）
// 2. 完成關卡數多者排前面
// 3. 總耗時短者排前面；尚未完成終點確認者無總耗時可比，並列於同關卡數的最後
function bucketOf(team) {
  return team.status === "FINISHED" && !team.is_late ? 0 : 1;
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
    if (a.team.current_index !== b.team.current_index) {
      return b.team.current_index - a.team.current_index;
    }
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
    if (team.status === "CHECKED_IN") {
      return `${rankIcon} ${team.group_no}組｜尚未出發`;
    }
    if (team.status === "FINISHED") {
      const elapsed = formatElapsed(team.start_time, team.finish_time);
      const tag = team.is_late ? "（逾時）" : "（準時）";
      return `${rankIcon} ${team.group_no}組｜${team.current_index}/${event.totalCheckpoints}｜${elapsed}${tag}`;
    }
    const elapsed = formatElapsed(team.start_time, nowIso());
    return `${rankIcon} ${team.group_no}組｜${team.current_index}/${event.totalCheckpoints}｜目前耗時 ${elapsed}（未歸隊）`;
  });
  return [textMsg(`🏆 排行榜\n${lines.join("\n")}`)];
}

module.exports = {
  checkin,
  depart,
  verifyKeyword,
  submitMedia,
  approveCheckpoint,
  revertLastCheckpoint,
  finishAtB6,
  freezeProgress,
  requestLeaderTransfer,
  confirmLeaderTransfer,
  unbindGroup,
  resetGame,
  queryCurrentCheckpoint,
  queryProgress,
  adminListProgress,
  isRankingPublic,
  setRankingPublic,
  formatRanking,
  findMembership: (userId) => findMembership(db, userId),
  findTeam: (groupNo) => findTeam(db, groupNo),
  getGroupMemberIds,
  textMsg,
};
