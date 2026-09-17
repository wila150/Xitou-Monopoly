// 對應架構文件「九、時間控管（10:30～12:30）」
module.exports = {
  // 12:30 建議回報上限，超過視為「未準時」，並作為自動結算時間點
  cutoffHour: 12,
  cutoffMinute: 30,
  // 12:15 系統對所有「闖關中」隊伍發送提醒通知
  reminderHour: 12,
  reminderMinute: 15,
  totalCheckpoints: 12,
};
