const cron = require("node-cron");
const { db } = require("./db");
const teamService = require("./services/teamService");
const lineClient = require("./lineClient");
const event = require("./config/event");

const TIMEZONE = process.env.TZ || "Asia/Taipei";

// 對應架構文件 v2「十一、時間控管｜建議於 12:15 左右發送提醒通知」
function startReminderJob() {
  const cronExpr = `${event.reminderMinute} ${event.reminderHour} * * *`;
  cron.schedule(
    cronExpr,
    async () => {
      const inProgress = await db.all(
        "SELECT group_no FROM teams WHERE status = 'IN_PROGRESS'"
      );
      for (const { group_no: groupNo } of inProgress) {
        const memberIds = await teamService.getGroupMemberIds(groupNo);
        await lineClient.pushToMany(memberIds, [
          teamService.textMsg(
            "⏰ 提醒：現在時間 12:15，12:30 後將停止受理新的關卡進度，請留意時間並儘速前往 B6 辦理終點確認！"
          ),
        ]);
      }
    },
    { timezone: TIMEZONE }
  );
}

// 對應架構文件 v2「十一、時間控管｜12:30 起系統停止受理新的關卡關鍵字」
// 注意：這裡只凍結「完成關卡數」，不會幫任何隊伍自動產生終點確認時間——
// 尚未到站的隊伍仍要實際抵達 B6、由工作人員觸發「到站 X組」才會有正式成績。
function startFreezeJob() {
  const cronExpr = `${event.cutoffMinute} ${event.cutoffHour} * * *`;
  cron.schedule(
    cronExpr,
    async () => {
      const { alreadyFrozen, groupNos } = await teamService.freezeProgress();
      if (alreadyFrozen) return;
      for (const groupNo of groupNos) {
        const memberIds = await teamService.getGroupMemberIds(groupNo);
        await lineClient.pushToMany(memberIds, [
          teamService.textMsg(
            "⏰ 12:30 已到，系統停止受理新的關卡進度（完成關卡數已凍結）。若尚未抵達 B6，請儘速前往辦理終點確認，逾時仍可辦理但會標註「逾時」。"
          ),
        ]);
      }
    },
    { timezone: TIMEZONE }
  );
}

function start() {
  startReminderJob();
  startFreezeJob();
  console.log(
    `已排程：每日 ${event.reminderHour}:${String(event.reminderMinute).padStart(2, "0")} 提醒、` +
      `${event.cutoffHour}:${String(event.cutoffMinute).padStart(2, "0")} 停止受理新關卡進度（時區 ${TIMEZONE}）`
  );
}

module.exports = { start };
