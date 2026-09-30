// 展示用字典与通用工具
export const ROLE_LABELS: Record<string, string> = {
  admin: "中心管理者",
  head_nurse: "护士长",
  nurse: "护理师",
  pediatrician: "儿科医生",
  nutritionist: "营养师",
  therapist: "产康师",
  matron: "月嫂",
  frontdesk: "前台",
  finance: "财务",
  family: "家属",
};

export const ROLE_HOME: Record<string, string> = {
  admin: "/admin",
  head_nurse: "/headnurse",
  nurse: "/nurse",
  pediatrician: "/doctor",
  nutritionist: "/nutritionist",
  therapist: "/therapist",
  matron: "/nurse",
  frontdesk: "/frontdesk",
  finance: "/finance",
  family: "/family",
};

export const PLAN_TYPES: Record<string, string> = {
  rounds: "护理查房",
  wound: "伤口观察",
  breast: "乳房护理",
  recovery: "产康课程",
  meal: "月子餐",
  baby_bath: "宝宝洗澡抚触",
  night_care: "夜间照护",
};

export const EX_TYPES: Record<string, string> = {
  jaundice: "宝宝黄疸升高",
  breast_blockage: "产妇乳腺堵塞",
  extra_visit: "家属临时增加探访",
  matron_leave: "月嫂请假",
  meal_taboo: "餐食不符合忌口",
  project_delay: "产康项目延期",
  package_upgrade: "套餐升级",
  room_upgrade: "房间升级",
  early_checkout: "提前退所",
  record_dispute: "家属质疑护理记录",
  checkout_dispute: "退所争议",
};

export const FEE_TYPES: Record<string, string> = {
  package: "套餐费用",
  upgrade: "升级差价",
  extra: "增项消费",
  deposit: "押金",
  discount: "减免",
  refund: "退款",
};

export const EX_STATUS: Record<string, string> = {
  open: "待处理",
  processing: "处理中",
  resolved: "已解决",
  closed: "已关闭",
};

export const SEVERITY: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "紧急",
};

export const TASK_STATUS: Record<string, string> = {
  pending: "待执行",
  done: "已完成",
  delayed: "已延期",
  missed: "已遗漏",
};

export const VISIT_STATUS: Record<string, string> = {
  pending: "待审核",
  approved: "已批准",
  rejected: "已拒绝",
  completed: "已完成",
  cancelled: "已取消",
};

export function money(n: unknown): string {
  const v = Number(n || 0);
  return "¥" + v.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// 提前退所退款方案状态
export const REFUND_PLAN_STATUS: Record<string, string> = {
  frozen: "尾款已冻结·待护理核对",
  care_verified: "护理已核对·待同步家属",
  family_synced: "已同步家属·待财务复核",
  disputed: "家属有异议·处理中",
  reviewed: "财务已复核·已退款出所",
  cancelled: "已撤回",
};
export const FAMILY_PLAN_STATUS: Record<string, string> = {
  pending: "待家属知悉",
  acked: "家属已知悉",
  disputed: "家属有异议",
};

export function dt(s: unknown): string {
  if (!s) return "-";
  return String(s).slice(0, 16);
}

export function badgeClass(status: string): string {
  switch (status) {
    case "open": case "pending": case "issue": case "new": case "frozen": case "disputed": return "badge red";
    case "processing": case "planned": case "scheduled": case "following": case "draft": case "care_verified": return "badge amber";
    case "resolved": case "done": case "confirmed": case "approved": case "delivered": case "responded": case "converted": case "reviewed": case "acked": return "badge green";
    case "closed": case "cancelled": case "void": case "rejected": case "lost": return "badge gray";
    case "completed": case "active": case "in_stay": case "family_synced": return "badge blue";
    case "checked_out": return "badge gray";
    default: return "badge gray";
  }
}

export function severityClass(sev: string): string {
  switch (sev) {
    case "critical": return "badge red";
    case "high": return "badge red";
    case "medium": return "badge amber";
    default: return "badge gray";
  }
}
