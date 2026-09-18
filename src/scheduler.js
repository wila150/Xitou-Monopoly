const cron = require("node-cron");
const { db } = require("./db");
const teamService = require("./services/teamService");
const lineClient = require("./lineClient");
const event = require("./config/event");

const TIMEZONE = process.env.TZ || "Asia/Taipei";

// 對應架構文件 v2「十一、時間控管｜建議於 12:15 左右發送提醒通知」
// 只提醒、不會停止受理進度：隊伍可能逾時才完成，逾時仍要能繼續闖關與辦理終點確認（成績標註「逾時」）。
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
            `⏰ 提醒：現在時間 12:15，活動即將進入尾聲，請留意時間並儘速前往 B6 辦理終點確認。逾時（出發後超過 ${event.maxDurationMinutes / 60} 小時）仍可繼續完成關卡與辦理終點確認，成績會標註「逾時」。`
          ),
        ]);
      }
    },
    { timezone: TIMEZONE }
  );
}

function start() {
  startReminderJob();
  console.log(
    `已排程：每日 ${event.reminderHour}:${String(event.reminderMinute).padStart(2, "0")} 提醒（時區 ${TIMEZONE}）`
  );
}

module.exports = { start };
