// 业务动作层：所有角色共用的业务逻辑。每个动作做角色校验、写库、写审计日志。
import { q, q1, run, now, today, addDays, hashPassword } from "./db";
import crypto from "node:crypto";
import type { SessionUser } from "./auth";

type Payload = Record<string, unknown>;
type Row = Record<string, unknown>;

function str(p: Payload, k: string, def = ""): string {
  const v = p[k];
  return v === undefined || v === null ? def : String(v).trim();
}
function num(p: Payload, k: string, def = 0): number {
  const v = Number(p[k]);
  return Number.isFinite(v) ? v : def;
}
function req(p: Payload, k: string, label: string): string {
  const v = str(p, k);
  if (!v) throw new Error(`请填写${label}`);
  return v;
}

export function audit(stayId: number | null, user: SessionUser | null, action: string, detail: string) {
  run("INSERT INTO audit_logs(stay_id,actor_id,actor_name,action,detail) VALUES(?,?,?,?,?)",
    stayId, user ? user.id : null, user ? user.name : "系统", action, detail);
}

// 异常类型 → 默认责任角色 / 是否同步护士长
const EX_ROUTE: Record<string, { role: string; sync: boolean }> = {
  jaundice: { role: "pediatrician", sync: true },
  breast_blockage: { role: "head_nurse", sync: true },
  extra_visit: { role: "frontdesk", sync: false },
  matron_leave: { role: "head_nurse", sync: true },
  meal_taboo: { role: "nutritionist", sync: true },
  project_delay: { role: "therapist", sync: false },
  package_upgrade: { role: "finance", sync: false },
  room_upgrade: { role: "frontdesk", sync: false },
  early_checkout: { role: "finance", sync: true },
  record_dispute: { role: "head_nurse", sync: true },
  checkout_dispute: { role: "head_nurse", sync: true },
};

export function createException(
  stayId: number, type: string, title: string, description: string,
  severity: string, user: SessionUser | null
): number {
  const route = EX_ROUTE[type] || { role: "head_nurse", sync: true };
  const id = run(
    `INSERT INTO exceptions(stay_id,type,title,description,severity,status,raised_by,raised_by_name,assigned_role,synced_head_nurse)
     VALUES(?,?,?,?,?,'open',?,?,?,?)`,
    stayId, type, title, description, severity,
    user ? user.id : null, user ? user.name : "系统", route.role, route.sync ? 1 : 0
  );
  run("INSERT INTO exception_events(exception_id,user_id,user_name,action,note) VALUES(?,?,?,?,?)",
    id, user ? user.id : null, user ? user.name : "系统", "created", description || title);
  audit(stayId, user, "异常上报", `【${title}】${description}`);
  return id;
}

// 忌口关键词（含常见同义词）
const TABOO_SYNONYMS: Record<string, string[]> = {
  "海鲜": ["海鲜", "虾", "蟹", "贝", "蛤", "海参", "鱿鱼", "带鱼", "鲅鱼"],
  "辛辣": ["辛辣", "辣", "椒", "麻辣", "咖喱"],
  "生冷": ["生冷", "生", "冰", "冷食", "沙拉", "刺身"],
};
export function checkTaboos(menu: string, taboos: string): string[] {
  const keys = taboos.split(/[、,，;；\s]+/).map((s) => s.replace(/^忌/, "").trim()).filter(Boolean);
  const hits = new Set<string>();
  for (const k of keys) {
    const words = TABOO_SYNONYMS[k] || [k];
    for (const w of words) {
      if (menu.includes(w)) { hits.add(k); break; }
    }
  }
  return [...hits];
}

function mustStay(stayId: number): Row {
  const s = q1("SELECT * FROM stays WHERE id=?", stayId);
  if (!s) throw new Error("订单不存在");
  return s;
}

function familyStayIds(userId: number): number[] {
  return q("SELECT stay_id FROM family_links WHERE user_id=?", userId).map((r) => Number(r.stay_id));
}

function assertFamilyStay(user: SessionUser, stayId: number) {
  if (user.role !== "family") return;
  if (!familyStayIds(user.id).includes(stayId)) throw new Error("无权访问该房间");
}

// 套餐尾款冻结：提前退所退款方案确认/复核前，禁止追加费用与退款，避免费用和服务记录脱节
function activeRefundPlan(stayId: number): Row | undefined {
  return q1("SELECT * FROM refund_plans WHERE stay_id=? AND status IN ('frozen','care_verified','family_synced','disputed')", stayId);
}
function assertNotFrozen(stayId: number) {
  const plan = activeRefundPlan(stayId);
  if (plan) throw new Error(`套餐尾款已冻结（退款方案#${plan.id}处理中），请先完成或撤回退款方案`);
}
function mustRefundPlan(planId: number): Row {
  const p = q1("SELECT * FROM refund_plans WHERE id=?", planId);
  if (!p) throw new Error("退款方案不存在");
  return p;
}
function planEvent(planId: number, user: SessionUser, action: string, note: string) {
  run("INSERT INTO refund_plan_events(plan_id,user_id,user_name,action,note) VALUES(?,?,?,?,?)",
    planId, user.id, user.name, action, note);
}
function planTouch(planId: number) {
  run("UPDATE refund_plans SET updated_at=? WHERE id=?", now(), planId);
}
const r2 = (n: number) => Math.round(n * 100) / 100;

// 平台核对：已住天数、已执行产康、餐食成本、赠送服务、押金
function buildRefundChecklist(stay: Row, checkoutDate: string) {
  const stayId = Number(stay.id);
  const pkg = q1("SELECT * FROM packages WHERE id=?", Number(stay.package_id))!;
  const stayed = Math.max(0, Math.round((new Date(checkoutDate).getTime() - new Date(String(stay.check_in_date)).getTime()) / 86400000));
  const remaining = Math.max(0, Math.round((new Date(String(stay.expected_checkout)).getTime() - new Date(checkoutDate).getTime()) / 86400000));
  const dailyRate = r2(Number(pkg.price) / Number(pkg.days));
  const roomCharge = r2(dailyRate * stayed);
  const mealDays = q1("SELECT COUNT(DISTINCT meal_date) AS c FROM meals WHERE stay_id=? AND substr(meal_date,1,10)<=?",
    stayId, checkoutDate)?.c ?? stayed;
  const recoveryDone = q1("SELECT COUNT(*) AS c FROM therapist_schedules WHERE stay_id=? AND status='done' AND substr(scheduled_at,1,10)<=?",
    stayId, checkoutDate)?.c ?? 0;
  const gifts = q("SELECT * FROM gifts WHERE stay_id=?", stayId);
  return {
    pkg, stayed, remaining, dailyRate, roomCharge,
    mealDays: Math.max(1, Number(mealDays) || stayed),
    recoveryDone: Number(recoveryDone),
    giftsDelivered: gifts.filter((g) => String(g.status) === "delivered"),
    giftsAll: gifts,
    depositFee: q1("SELECT COALESCE(SUM(amount),0) AS s FROM fees WHERE stay_id=? AND type='deposit' AND direction='charge' AND status='confirmed'", stayId),
    extraFees: q("SELECT COALESCE(amount,0) AS amount FROM fees WHERE stay_id=? AND type='extra' AND direction='charge' AND status='confirmed'", stayId),
  };
}

// ---------------------------------------------------------------- actions
type Handler = (user: SessionUser, p: Payload) => unknown;

const ACTIONS: Record<string, { roles: string[]; run: Handler }> = {
  // ---- 入住登记（前台/管理者）----
  "stays.create": {
    roles: ["frontdesk", "admin"],
    run(user, p) {
      const roomId = num(p, "roomId");
      const room = q1("SELECT * FROM rooms WHERE id=?", roomId);
      if (!room) throw new Error("房间不存在");
      if (room.status !== "vacant") throw new Error("该房间不是空房状态");
      const pkg = q1("SELECT * FROM packages WHERE id=?", num(p, "packageId"));
      if (!pkg) throw new Error("套餐不存在");
      const mother = req(p, "motherName", "产妇姓名");
      const checkIn = req(p, "checkInDate", "入住日期");
      const days = Number(pkg.days);
      const expected = addDays(checkIn, days);
      let code = `M${checkIn.replaceAll("-", "")}-${room.number}`;
      if (q1("SELECT id FROM stays WHERE code=?", code)) {
        code = `${code}-${(q1("SELECT COUNT(*) AS c FROM stays")?.c ?? 0)}`;
      }
      const permissions = JSON.stringify({
        careSummary: true, fees: true, visits: true,
        visitors: str(p, "visitors").split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
      });
      const stayId = run(
        `INSERT INTO stays(code,room_id,package_id,mother_name,mother_phone,delivery_method,postpartum_days,
          allergy_history,feeding_method,meal_taboos,doctor_advice,visit_permissions,
          baby_name,baby_weight,jaundice_level,jaundice_note,status,check_in_date,expected_checkout,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'in_stay',?,?,?)`,
        code, roomId, Number(pkg.id), mother, str(p, "motherPhone"),
        str(p, "deliveryMethod"), num(p, "postpartumDays"),
        str(p, "allergyHistory"), str(p, "feedingMethod"), str(p, "mealTaboos"),
        str(p, "doctorAdvice"), permissions,
        str(p, "babyName"), num(p, "babyWeight"), num(p, "jaundiceLevel"), str(p, "jaundiceNote"),
        checkIn, expected, user.id
      );
      run("UPDATE rooms SET status='occupied' WHERE id=?", roomId);
      // 默认护理计划
      const defaults: [string, string, string][] = [
        ["rounds", "护理查房", "每日2次"],
        ["wound", "伤口观察", "每日1次"],
        ["breast", "乳房护理", "每日1次"],
        ["recovery", "产康课程", "每周3次"],
        ["meal", "月子餐", "每日三餐三点"],
        ["baby_bath", "宝宝洗澡抚触", "每日1次"],
        ["night_care", "夜间照护", "每日 20:00-08:00"],
      ];
      for (const [type, title, freq] of defaults) {
        run("INSERT INTO care_plans(stay_id,type,title,frequency,note) VALUES(?,?,?,?,?)",
          stayId, type, title, freq, str(p, "mealTaboos") ? `忌口：${str(p, "mealTaboos")}` : "");
      }
      // 套餐赠品
      const gifts = JSON.parse(String(pkg.gifts || "[]")) as string[];
      for (const gname of gifts) {
        run("INSERT INTO gifts(stay_id,name,source) VALUES(?,?,'package')", stayId, gname);
      }
      // 费用：套餐 + 押金
      run("INSERT INTO fees(stay_id,type,direction,amount,description,created_by) VALUES(?,?,?,?,?,?)",
        stayId, "package", "charge", Number(pkg.price), `${pkg.name}费用`, user.id);
      const deposit = num(p, "deposit", 0);
      if (deposit > 0) {
        run("INSERT INTO fees(stay_id,type,direction,amount,description,created_by) VALUES(?,?,?,?,?,?)",
          stayId, "deposit", "charge", deposit, "入住押金", user.id);
      }
      // 家属账号
      const famUser = str(p, "familyUsername");
      const famName = str(p, "familyName");
      if (famUser && famName) {
        const exists = q1("SELECT id FROM users WHERE username=?", famUser);
        let uid: number;
        if (exists) {
          uid = Number(exists.id);
        } else {
          const salt = crypto.randomBytes(8).toString("hex");
          uid = run("INSERT INTO users(username,password_hash,salt,name,role,phone) VALUES(?,?,?,?,?,?)",
            famUser, hashPassword(str(p, "familyPassword", "family123"), salt),
            salt, famName, "family", str(p, "familyPhone"));
        }
        run("INSERT INTO family_links(stay_id,user_id,name,relation) VALUES(?,?,?,?)",
          stayId, uid, famName, str(p, "familyRelation", "家属"));
      }
      audit(stayId, user, "入住登记", `${mother}入住${room.number}（${pkg.name}），预产期出所${expected}`);
      return { id: stayId, message: `入住登记成功，订单号 ${code}` };
    },
  },

  // ---- 房间状态流转（清扫完成→空房等）----
  "rooms.update": {
    roles: ["frontdesk", "admin"],
    run(user, p) {
      const room = q1("SELECT * FROM rooms WHERE id=?", num(p, "id"));
      if (!room) throw new Error("房间不存在");
      const status = req(p, "status", "状态");
      if (!["vacant", "occupied", "cleaning"].includes(status)) throw new Error("非法房间状态");
      run("UPDATE rooms SET status=? WHERE id=?", status, Number(room.id));
      audit(null, user, "房间状态", `房间${room.number} → ${status}`);
      return { message: `房间${room.number}已更新` };
    },
  },

  // ---- 出所（正常到期；提前退所须走"退款方案核对→护理确认→家属同步→财务复核"流程）----
  "stays.checkout": {
    roles: ["frontdesk", "finance", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const stay = mustStay(stayId);
      if (stay.status !== "in_stay") throw new Error("该订单已出所");
      const todayStr = today();
      const early = todayStr < String(stay.expected_checkout);
      // 提前退所：统一走退款方案流程，避免费用与服务记录脱节
      if (early) {
        const plan = q1("SELECT * FROM refund_plans WHERE stay_id=? ORDER BY id DESC LIMIT 1", stayId);
        if (plan && ["frozen", "care_verified", "family_synced", "disputed"].includes(String(plan.status))) {
          throw new Error(`该房已有进行中的提前退所退款方案（#${plan.id}），请在财务工作台完成护理核对/家属同步/财务复核`);
        }
        throw new Error("提前退所请先由财务在工作台「提前退所结算」发起退款方案：核对已住天数/已执行产康/餐食成本/赠送服务/押金并冻结套餐尾款");
      }
      // 正常到期出所：结算单
      const fees = q("SELECT * FROM fees WHERE stay_id=? AND status='confirmed'", stayId);
      const charge = fees.filter((f) => f.direction === "charge").reduce((s, f) => s + Number(f.amount), 0);
      const refundSum = fees.filter((f) => f.direction === "refund").reduce((s, f) => s + Number(f.amount), 0);
      run(`INSERT INTO settlements(stay_id,total_charge,total_refund,paid,balance,detail,status)
           VALUES(?,?,?,?,?,?,'draft')
           ON CONFLICT(stay_id) DO UPDATE SET total_charge=excluded.total_charge,total_refund=excluded.total_refund,balance=excluded.balance`,
        stayId, charge, refundSum, 0, charge - refundSum, "正常出所结算");
      run("UPDATE stays SET status='checked_out', actual_checkout=? WHERE id=?", todayStr, stayId);
      run("UPDATE rooms SET status='cleaning' WHERE id=?", Number(stay.room_id));
      // 出所后随访计划
      run("INSERT INTO follow_ups(stay_id,type,scheduled_at,content,created_by) VALUES(?,?,?,?,?)",
        stayId, "回访", addDays(todayStr, 3) + " 10:00", "出所后3天电话回访（恢复情况、满意度）", user.id);
      run("INSERT INTO follow_ups(stay_id,type,scheduled_at,content,created_by) VALUES(?,?,?,?,?)",
        stayId, "母婴随访", addDays(todayStr, 30) + " 10:00", "出所后1个月母婴随访（儿保+产康复查提醒）", user.id);
      audit(stayId, user, "出所登记", `结算：应收${charge}，已退${refundSum}，待确认`);
      return { message: "已办理出所，结算单待财务确认" };
    },
  },

  // ---- 套餐/房间升级 ----
  "stays.upgrade": {
    roles: ["frontdesk", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const stay = mustStay(stayId);
      if (stay.status !== "in_stay") throw new Error("已出所订单不能升级");
      assertNotFrozen(stayId);
      const newPkg = q1("SELECT * FROM packages WHERE id=?", num(p, "newPackageId"));
      if (!newPkg) throw new Error("目标套餐不存在");
      const oldPkg = q1("SELECT * FROM packages WHERE id=?", Number(stay.package_id))!;
      if (Number(newPkg.id) === Number(oldPkg.id)) throw new Error("已是该套餐");
      const diff = Number(newPkg.price) - Number(oldPkg.price);
      const total = Number(oldPkg.days);
      const used = Math.max(0, Math.round((new Date(today()).getTime() - new Date(String(stay.check_in_date)).getTime()) / 86400000));
      const remainRatio = Math.max(0, (total - used) / total);
      const upgradeFee = Math.max(0, Math.round(diff * remainRatio));
      if (upgradeFee > 0) {
        run("INSERT INTO fees(stay_id,type,direction,amount,description,created_by) VALUES(?,?,?,?,?,?)",
          stayId, "upgrade", "charge", upgradeFee,
          `套餐升级差价（${oldPkg.name}→${newPkg.name}，按剩余${total - used}天折算）`, user.id);
      }
      // 房型变化则换房
      let roomNote = "";
      if (newPkg.room_type !== oldPkg.room_type) {
        const newRoom = q1("SELECT * FROM rooms WHERE type=? AND status='vacant' ORDER BY number LIMIT 1", String(newPkg.room_type));
        if (newRoom) {
          run("UPDATE rooms SET status='cleaning' WHERE id=?", Number(stay.room_id));
          run("UPDATE rooms SET status='occupied' WHERE id=?", Number(newRoom.id));
          run("UPDATE stays SET room_id=? WHERE id=?", Number(newRoom.id), stayId);
          roomNote = `，房间由${(q1("SELECT number FROM rooms WHERE id=?", Number(stay.room_id)) || {}).number || ""}调整至${newRoom.number}`;
        } else {
          roomNote = `，暂无${newPkg.room_type}空房，暂留原房间`;
        }
      }
      // 新套餐赠品补齐
      const newGifts = JSON.parse(String(newPkg.gifts || "[]")) as string[];
      const existing = q("SELECT name FROM gifts WHERE stay_id=?", stayId).map((g) => String(g.name));
      for (const gname of newGifts) {
        if (!existing.includes(gname)) run("INSERT INTO gifts(stay_id,name,source) VALUES(?,?,'package')", stayId, gname);
      }
      run("UPDATE stays SET package_id=?, expected_checkout=? WHERE id=?",
        Number(newPkg.id), addDays(String(stay.check_in_date), Number(newPkg.days)), stayId);
      createException(stayId, "package_upgrade", `套餐升级：${oldPkg.name}→${newPkg.name}`,
        `补差价${upgradeFee}元${roomNote}`, "low", user);
      audit(stayId, user, "套餐升级", `${oldPkg.name}→${newPkg.name}，补差价${upgradeFee}元${roomNote}`);
      return { message: `升级成功，补差价 ${upgradeFee} 元${roomNote}` };
    },
  },

  // ---- 护理计划 ----
  "plans.create": {
    roles: ["head_nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO care_plans(stay_id,type,title,frequency,assignee_id,note) VALUES(?,?,?,?,?,?)",
        stayId, req(p, "type", "计划类型"), req(p, "title", "计划名称"),
        str(p, "frequency"), num(p, "assigneeId") || null, str(p, "note"));
      audit(stayId, user, "护理计划", `新增计划：${str(p, "title")}（${str(p, "frequency")}）`);
      return { id };
    },
  },

  // ---- 护理任务 ----
  "tasks.create": {
    roles: ["head_nurse", "nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO care_tasks(stay_id,plan_id,type,title,scheduled_at,assignee_id,visible_to_family) VALUES(?,?,?,?,?,?,?)",
        stayId, num(p, "planId") || null, req(p, "type", "任务类型"), req(p, "title", "任务名称"),
        req(p, "scheduledAt", "计划时间"), num(p, "assigneeId") || null, p.visibleToFamily === false ? 0 : 1);
      audit(stayId, user, "任务安排", `新增任务：${str(p, "title")} @ ${str(p, "scheduledAt")}`);
      return { id };
    },
  },

  // 从计划生成某日任务
  "tasks.generate": {
    roles: ["head_nurse", "nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const date = str(p, "date", today());
      const plans = q("SELECT * FROM care_plans WHERE stay_id=? AND status='active'", stayId);
      let created = 0;
      for (const pl of plans) {
        const exists = q1("SELECT id FROM care_tasks WHERE stay_id=? AND plan_id=? AND scheduled_at LIKE ?",
          stayId, Number(pl.id), `${date}%`);
        if (exists) continue;
        const time = pl.type === "night_care" ? `${date} 20:00` : pl.type === "rounds" ? `${date} 08:30` : `${date} 10:00`;
        run("INSERT INTO care_tasks(stay_id,plan_id,type,title,scheduled_at,assignee_id) VALUES(?,?,?,?,?,?)",
          stayId, Number(pl.id), String(pl.type), String(pl.title), time,
          pl.assignee_id === null ? null : Number(pl.assignee_id));
        created++;
      }
      audit(stayId, user, "任务生成", `生成${date}护理任务${created}项`);
      return { message: `已生成 ${created} 项任务` };
    },
  },

  "tasks.update": {
    roles: ["nurse", "matron", "head_nurse", "admin", "nutritionist", "therapist"],
    run(user, p) {
      const id = num(p, "id");
      const t = q1("SELECT * FROM care_tasks WHERE id=?", id);
      if (!t) throw new Error("任务不存在");
      const status = req(p, "status", "状态");
      const record = str(p, "record");
      run("UPDATE care_tasks SET status=?, done_at=CASE WHEN ?='done' THEN ? ELSE done_at END, done_by=CASE WHEN ?='done' THEN ? ELSE done_by END, record=?, visible_to_family=? WHERE id=?",
        status, status, now(), status, user.id, record || String(t.record || ""),
        p.visibleToFamily === undefined ? Number(t.visible_to_family) : (p.visibleToFamily ? 1 : 0), id);
      if (status === "done" && record) {
        run("INSERT INTO care_records(stay_id,task_id,type,content,created_by,created_by_name,visible_to_family) VALUES(?,?,?,?,?,?,?)",
          Number(t.stay_id), id, String(t.type), record, user.id, user.name, Number(t.visible_to_family));
      }
      audit(Number(t.stay_id), user, "护理执行", `任务「${t.title}」→ ${status}${record ? "：" + record : ""}`);
      return { message: "已更新" };
    },
  },

  // ---- 护理记录 ----
  "records.create": {
    roles: ["nurse", "matron", "head_nurse", "admin", "pediatrician"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO care_records(stay_id,task_id,type,content,created_by,created_by_name,visible_to_family) VALUES(?,?,?,?,?,?,?)",
        stayId, num(p, "taskId") || null, str(p, "type", "general"), req(p, "content", "记录内容"),
        user.id, user.name, p.visibleToFamily === false ? 0 : 1);
      audit(stayId, user, "护理记录", str(p, "content").slice(0, 60));
      return { id };
    },
  },

  // 家属质疑护理记录
  "records.dispute": {
    roles: ["family"],
    run(user, p) {
      const id = num(p, "id");
      const rec = q1("SELECT * FROM care_records WHERE id=?", id);
      if (!rec) throw new Error("记录不存在");
      assertFamilyStay(user, Number(rec.stay_id));
      run("UPDATE care_records SET disputed=1 WHERE id=?", id);
      createException(Number(rec.stay_id), "record_dispute", "家属质疑护理记录",
        `记录#${id}「${String(rec.content).slice(0, 50)}」被质疑：${str(p, "reason") || "未填写原因"}`, "high", user);
      return { message: "已提交质疑，护士长将介入核查" };
    },
  },

  // ---- 月子餐 ----
  "meals.create": {
    roles: ["nutritionist", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const stay = mustStay(stayId);
      const menu = req(p, "menu", "菜单");
      const hits = checkTaboos(menu, String(stay.meal_taboos || ""));
      const status = hits.length ? "issue" : "planned";
      const id = run("INSERT INTO meals(stay_id,meal_date,meal_type,menu,taboo_hits,status,created_by) VALUES(?,?,?,?,?,?,?)",
        stayId, req(p, "mealDate", "日期"), req(p, "mealType", "餐次"), menu, hits.join("、"), status, user.id);
      if (hits.length) {
        createException(stayId, "meal_taboo", `月子餐命中忌口：${hits.join("、")}`,
          `${str(p, "mealDate")} ${str(p, "mealType")}「${menu}」含忌口食材（${hits.join("、")}），请营养师立即调整。`, "high", user);
      }
      audit(stayId, user, "配餐登记", `${str(p, "mealDate")} ${str(p, "mealType")}${hits.length ? "（命中忌口：" + hits.join("、") + "）" : ""}`);
      return { id, tabooHits: hits, message: hits.length ? `警告：命中忌口 ${hits.join("、")}` : "已登记" };
    },
  },

  "meals.update": {
    roles: ["nutritionist", "admin"],
    run(user, p) {
      const id = num(p, "id");
      const m = q1("SELECT * FROM meals WHERE id=?", id);
      if (!m) throw new Error("餐食记录不存在");
      run("UPDATE meals SET status=?, note=? WHERE id=?", req(p, "status", "状态"), str(p, "note"), id);
      audit(Number(m.stay_id), user, "餐食处理", `${m.meal_date} ${m.meal_type} → ${str(p, "status")}${str(p, "note") ? "：" + str(p, "note") : ""}`);
      return { message: "已更新" };
    },
  },

  // ---- 探访 ----
  "visits.create": {
    roles: ["family", "frontdesk", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      assertFamilyStay(user, stayId);
      const stay = mustStay(stayId);
      if (stay.status !== "in_stay") throw new Error("已出所，无法预约探访");
      const isTemp = p.isTemp === true || p.isTemp === "true" || num(p, "isTemp") === 1 ? 1 : 0;
      const id = run("INSERT INTO visits(stay_id,visitor_name,relation,visit_time,hours,is_temp,created_by) VALUES(?,?,?,?,?,?,?)",
        stayId, req(p, "visitorName", "探访人"), str(p, "relation"), req(p, "visitTime", "探访时间"),
        num(p, "hours", 2), isTemp, user.id);
      if (isTemp) {
        createException(stayId, "extra_visit", "家属临时增加探访",
          `${str(p, "visitorName")}（${str(p, "relation")}）申请临时探访：${str(p, "visitTime")}`, "medium", user);
      }
      audit(stayId, user, "探访预约", `${str(p, "visitorName")} 预约 ${str(p, "visitTime")}${isTemp ? "（临时）" : ""}`);
      return { id, message: "探访预约已提交，待前台审核" };
    },
  },

  "visits.update": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const id = num(p, "id");
      const v = q1("SELECT * FROM visits WHERE id=?", id);
      if (!v) throw new Error("探访记录不存在");
      const action = req(p, "action", "操作");
      if (action === "approve" || action === "reject") {
        run("UPDATE visits SET status=?, approved_by=? WHERE id=?", action === "approve" ? "approved" : "rejected", user.id, id);
      } else if (action === "disinfect") {
        run("UPDATE visits SET disinfected=1, disinfection_note=? WHERE id=?", str(p, "note", "入所前消毒+测温完成"), id);
      } else if (action === "complete") {
        run("UPDATE visits SET status='completed' WHERE id=?", id);
      } else if (action === "cancel") {
        run("UPDATE visits SET status='cancelled' WHERE id=?", id);
      } else {
        throw new Error("未知操作");
      }
      audit(Number(v.stay_id), user, "探访管理", `${v.visitor_name}（${v.visit_time}）：${action}`);
      return { message: "已处理" };
    },
  },

  // ---- 费用 ----
  "fees.create": {
    roles: ["finance", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      assertNotFrozen(stayId);
      const amount = num(p, "amount");
      if (amount <= 0) throw new Error("金额必须大于0");
      const id = run("INSERT INTO fees(stay_id,type,direction,amount,description,created_by) VALUES(?,?,?,?,?,?)",
        stayId, req(p, "type", "费用类型"), str(p, "direction", "charge"), amount, str(p, "description"), user.id);
      audit(stayId, user, "费用登记", `${str(p, "description") || str(p, "type")} ${amount}元`);
      return { id };
    },
  },

  "fees.void": {
    roles: ["finance", "admin"],
    run(user, p) {
      const f = q1("SELECT * FROM fees WHERE id=?", num(p, "id"));
      if (!f) throw new Error("费用不存在");
      assertNotFrozen(Number(f.stay_id));
      run("UPDATE fees SET status='void' WHERE id=?", Number(f.id));
      audit(Number(f.stay_id), user, "费用作废", `${f.description} ${f.amount}元`);
      return { message: "已作废" };
    },
  },

  // ---- 赠品 ----
  "gifts.create": {
    roles: ["frontdesk", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO gifts(stay_id,name,source) VALUES(?,?,'added')", stayId, req(p, "name", "赠品名称"));
      audit(stayId, user, "赠品登记", str(p, "name"));
      return { id };
    },
  },

  "gifts.deliver": {
    roles: ["frontdesk", "admin"],
    run(user, p) {
      const g = q1("SELECT * FROM gifts WHERE id=?", num(p, "id"));
      if (!g) throw new Error("赠品不存在");
      run("UPDATE gifts SET status='delivered', delivered_at=?, delivered_by=? WHERE id=?", now(), user.id, Number(g.id));
      audit(Number(g.stay_id), user, "赠品发放", String(g.name));
      return { message: "已发放" };
    },
  },

  // ---- 产康排班 ----
  "schedules.create": {
    roles: ["therapist", "head_nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO therapist_schedules(stay_id,therapist_id,project,scheduled_at) VALUES(?,?,?,?)",
        stayId, num(p, "therapistId") || user.id, req(p, "project", "项目"), req(p, "scheduledAt", "时间"));
      audit(stayId, user, "产康排班", `${str(p, "project")} @ ${str(p, "scheduledAt")}`);
      return { id };
    },
  },

  "schedules.update": {
    roles: ["therapist", "head_nurse", "admin"],
    run(user, p) {
      const s = q1("SELECT * FROM therapist_schedules WHERE id=?", num(p, "id"));
      if (!s) throw new Error("排班不存在");
      const action = req(p, "action", "操作");
      if (action === "done") {
        run("UPDATE therapist_schedules SET status='done', done_at=? WHERE id=?", now(), Number(s.id));
      } else if (action === "delay") {
        const reason = req(p, "reason", "延期原因");
        run("UPDATE therapist_schedules SET status='delayed', delay_reason=?, scheduled_at=? WHERE id=?",
          reason, str(p, "newTime", String(s.scheduled_at)), Number(s.id));
        createException(Number(s.stay_id), "project_delay", `产康项目延期：${s.project}`,
          `原时间${s.scheduled_at}，原因：${reason}`, "low", user);
      } else if (action === "cancel") {
        run("UPDATE therapist_schedules SET status='cancelled' WHERE id=?", Number(s.id));
      } else {
        throw new Error("未知操作");
      }
      audit(Number(s.stay_id), user, "产康排班", `${s.project} → ${action}`);
      return { message: "已更新" };
    },
  },

  // ---- 宝宝托管日志 ----
  "hosting.create": {
    roles: ["nurse", "matron", "head_nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const stay = mustStay(stayId);
      const id = run("INSERT INTO hosting_logs(stay_id,baby_name,type,start_time,end_time,caregiver_id,caregiver_name,notes) VALUES(?,?,?,?,?,?,?,?)",
        stayId, String(stay.baby_name || "宝宝"), str(p, "type", "托管"),
        req(p, "startTime", "开始时间"), str(p, "endTime") || null, user.id, user.name, str(p, "notes"));
      audit(stayId, user, "托管日志", `${str(p, "type", "托管")} ${str(p, "startTime")}`);
      return { id };
    },
  },

  // ---- 医生巡诊 ----
  "rounds.create": {
    roles: ["pediatrician", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO doctor_rounds(stay_id,doctor_id,doctor_name,round_date,findings,advice) VALUES(?,?,?,?,?,?)",
        stayId, user.id, user.name, str(p, "roundDate", today()), str(p, "findings"), str(p, "advice"));
      // 黄疸复测值更新
      const jl = num(p, "jaundiceLevel", -1);
      if (jl >= 0) {
        run("UPDATE stays SET jaundice_level=?, jaundice_note=? WHERE id=?", jl, str(p, "jaundiceNote", String(mustStay(stayId).jaundice_note || "")), stayId);
      }
      audit(stayId, user, "医生巡诊", str(p, "findings").slice(0, 60));
      return { id };
    },
  },

  // ---- 异常工单 ----
  "exceptions.create": {
    roles: ["admin", "head_nurse", "nurse", "matron", "pediatrician", "nutritionist", "therapist", "frontdesk", "finance", "family"],
    run(user, p) {
      const stayId = num(p, "stayId");
      assertFamilyStay(user, stayId);
      mustStay(stayId);
      const id = createException(stayId, req(p, "type", "异常类型"), req(p, "title", "标题"),
        str(p, "description"), str(p, "severity", "medium"), user);
      return { id, message: "异常工单已创建" };
    },
  },

  "exceptions.update": {
    roles: ["admin", "head_nurse", "nurse", "pediatrician", "nutritionist", "therapist", "frontdesk", "finance"],
    run(user, p) {
      const ex = q1("SELECT * FROM exceptions WHERE id=?", num(p, "id"));
      if (!ex) throw new Error("工单不存在");
      const action = req(p, "action", "操作");
      const note = str(p, "note");
      let status = String(ex.status);
      if (action === "accept") status = "processing";
      else if (action === "resolve") { status = "resolved"; }
      else if (action === "close") status = "closed";
      else if (action === "note") { /* 仅追加处理记录 */ }
      else throw new Error("未知操作");
      run("UPDATE exceptions SET status=?, resolution=CASE WHEN ?='resolve' THEN ? ELSE resolution END, resolved_at=CASE WHEN ?='resolve' THEN ? ELSE resolved_at END, updated_at=? WHERE id=?",
        status, action, note, action, now(), now(), Number(ex.id));
      run("INSERT INTO exception_events(exception_id,user_id,user_name,action,note) VALUES(?,?,?,?,?)",
        Number(ex.id), user.id, user.name, action === "note" ? "note" : action, note);
      audit(Number(ex.stay_id), user, "异常处置", `【${ex.title}】${action}${note ? "：" + note : ""}`);
      return { message: "已更新工单" };
    },
  },

  // ---- 月嫂请假 ----
  "matron.leave": {
    roles: ["matron", "head_nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const stay = mustStay(stayId);
      const from = req(p, "fromDate", "请假开始");
      const to = req(p, "toDate", "请假结束");
      const reason = str(p, "reason");
      const reassignTo = num(p, "reassignTo");
      createException(stayId, "matron_leave", `月嫂请假（${from} 至 ${to}）`,
        `申请人：${user.name}。原因：${reason || "事假"}`, "medium", user);
      let note = "";
      if (reassignTo) {
        const target = q1("SELECT * FROM users WHERE id=?", reassignTo);
        if (target) {
          const r = getAffectedTasks(stayId, from, to);
          for (const t of r) run("UPDATE care_tasks SET assignee_id=? WHERE id=?", reassignTo, Number(t.id));
          note = `，${r.length}项夜间照护任务已改派${target.name}`;
        }
      }
      audit(stayId, user, "月嫂请假", `${from}至${to}：${reason}${note}`);
      return { message: `请假已登记${note}` };
    },
  },

  // ---- 家属反馈 ----
  "feedbacks.create": {
    roles: ["family"],
    run(user, p) {
      const stayId = num(p, "stayId");
      assertFamilyStay(user, stayId);
      const rating = Math.min(5, Math.max(1, num(p, "rating", 5)));
      const id = run("INSERT INTO feedbacks(stay_id,user_id,user_name,rating,content) VALUES(?,?,?,?,?)",
        stayId, user.id, user.name, rating, req(p, "content", "反馈内容"));
      audit(stayId, user, "家属反馈", `评分${rating}：${str(p, "content").slice(0, 50)}`);
      return { id, message: "反馈已提交，感谢评价" };
    },
  },

  "feedbacks.respond": {
    roles: ["head_nurse", "admin"],
    run(user, p) {
      const f = q1("SELECT * FROM feedbacks WHERE id=?", num(p, "id"));
      if (!f) throw new Error("反馈不存在");
      const affect = p.affectScheduling === true || num(p, "affectScheduling") === 1 ? 1 : 0;
      run("UPDATE feedbacks SET status='responded', response=?, affect_scheduling=?, handled_by=? WHERE id=?",
        req(p, "response", "回复内容"), affect, user.id, Number(f.id));
      audit(Number(f.stay_id), user, "反馈回复", `回复评分${f.rating}的反馈${affect ? "（已标记影响排班）" : ""}`);
      return { message: "已回复" };
    },
  },

  // ---- 随访 ----
  "followups.create": {
    roles: ["head_nurse", "admin", "frontdesk"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO follow_ups(stay_id,type,scheduled_at,content,created_by) VALUES(?,?,?,?,?)",
        stayId, str(p, "type", "回访"), req(p, "scheduledAt", "随访时间"), str(p, "content"), user.id);
      audit(stayId, user, "随访安排", `${str(p, "type", "回访")} @ ${str(p, "scheduledAt")}`);
      return { id };
    },
  },

  "followups.done": {
    roles: ["head_nurse", "admin", "frontdesk"],
    run(user, p) {
      const f = q1("SELECT * FROM follow_ups WHERE id=?", num(p, "id"));
      if (!f) throw new Error("随访不存在");
      run("UPDATE follow_ups SET status='done', result=?, done_at=? WHERE id=?", str(p, "result"), now(), Number(f.id));
      audit(Number(f.stay_id), user, "随访完成", str(p, "result").slice(0, 60));
      return { message: "已记录随访结果" };
    },
  },

  // ---- 复购/转介绍 ----
  "referrals.create": {
    roles: ["frontdesk", "admin", "head_nurse"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO referrals(stay_id,kind,lead_name,lead_phone,note) VALUES(?,?,?,?,?)",
        stayId, str(p, "kind", "referral"), req(p, "leadName", "线索姓名"), str(p, "leadPhone"), str(p, "note"));
      audit(stayId, user, "线索登记", `${str(p, "kind") === "repurchase" ? "复购" : "转介绍"}：${str(p, "leadName")}`);
      return { id };
    },
  },

  "referrals.update": {
    roles: ["frontdesk", "admin", "head_nurse"],
    run(user, p) {
      const r = q1("SELECT * FROM referrals WHERE id=?", num(p, "id"));
      if (!r) throw new Error("线索不存在");
      run("UPDATE referrals SET status=? WHERE id=?", req(p, "status", "状态"), Number(r.id));
      audit(Number(r.stay_id), user, "线索跟进", `${r.lead_name} → ${str(p, "status")}`);
      return { message: "已更新" };
    },
  },

  // ---- 家属沟通 ----
  "messages.create": {
    roles: ["admin", "head_nurse", "nurse", "matron", "pediatrician", "nutritionist", "therapist", "frontdesk", "finance", "family"],
    run(user, p) {
      const stayId = num(p, "stayId");
      assertFamilyStay(user, stayId);
      const audience = user.role === "family" ? "staff" : str(p, "audience", "all");
      const id = run("INSERT INTO messages(stay_id,from_user_id,from_name,from_role,audience,content) VALUES(?,?,?,?,?,?)",
        stayId, user.id, user.name, user.role, audience, req(p, "content", "内容"));
      audit(stayId, user, "家属沟通", str(p, "content").slice(0, 60));
      return { id };
    },
  },

  // ---- 提前退所退款方案：发起核对并冻结套餐尾款 ----
  "refund_plans.create": {
    roles: ["finance", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const stay = mustStay(stayId);
      if (stay.status !== "in_stay") throw new Error("该订单已出所，无需发起提前退所");
      if (activeRefundPlan(stayId)) throw new Error("该房已有进行中的退款方案，请在原方案上处理");
      const checkoutDate = req(p, "checkoutDate", "实际退所日期");
      if (checkoutDate < String(stay.check_in_date)) throw new Error("退所日期不能早于入住日期");
      if (checkoutDate >= String(stay.expected_checkout)) throw new Error("未提前于预计出所日期，请按正常出所办理");
      const reason = req(p, "reason", "退所原因");

      const c = buildRefundChecklist(stay, checkoutDate);
      const mealUnit = num(p, "mealUnitCost", 120);
      const recoveryUnit = num(p, "recoveryUnitCost", 380);
      const giftUnit = num(p, "giftUnitValue", 300);
      const mealCost = r2(c.mealDays * mealUnit);
      const recoveryCost = r2(c.recoveryDone * recoveryUnit);
      const giftsValue = r2(c.giftsDelivered.length * giftUnit);
      const deposit = r2(Number(c.depositFee?.s || 0));
      const extraCharge = r2(c.extraFees.reduce((s, f) => s + Number(f.amount), 0));
      const otherDeduction = num(p, "otherDeduction");
      const otherAdjustment = num(p, "otherAdjustment");
      const totalConsumed = r2(c.roomCharge + mealCost + recoveryCost + giftsValue + extraCharge + otherDeduction);
      const totalRefund = r2(deposit + Number(c.pkg.price) - totalConsumed + otherAdjustment);
      const giftsNote = c.giftsAll.length
        ? `已发放${c.giftsDelivered.length}项（${c.giftsDelivered.map((g) => g.name).join("、") || "无"}，折算${giftsValue}元）；待发放${c.giftsAll.length - c.giftsDelivered.length}项随退所核销不收费`
        : "无套餐赠品";

      const planId = run(
        `INSERT INTO refund_plans(stay_id,reason,checkout_date,stayed_days,remaining_days,daily_rate,room_charge,
          meal_days,meal_unit_cost,meal_cost,recovery_done_count,recovery_unit_cost,recovery_cost,
          gifts_delivered_value,gifts_note,deposit_amount,extra_charge,other_deduction,other_adjustment,adjustment_note,
          frozen_balance,total_consumed,total_refund,status,care_verified,family_status,review_status,created_by,created_by_name)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'frozen',0,'pending','pending',?,?)`,
        stayId, reason, checkoutDate, c.stayed, c.remaining, c.dailyRate, c.roomCharge,
        c.mealDays, mealUnit, mealCost, c.recoveryDone, recoveryUnit, recoveryCost,
        giftsValue, giftsNote, deposit, extraCharge, otherDeduction, otherAdjustment, str(p, "adjustmentNote"),
        Number(c.pkg.price), totalConsumed, totalRefund, user.id, user.name
      );
      run("UPDATE stays SET checkout_date=? WHERE id=?", checkoutDate, stayId);
      planEvent(planId, user, "created", `产妇${reason ? "因" + reason : ""}申请提前退所，拟${checkoutDate}退所；平台开始核对已住天数、已执行产康、餐食成本、赠送服务与押金。`);
      planEvent(planId, user, "calculated",
        `核对：已住${c.stayed}天（房型费用${c.roomCharge}元，日均价${c.dailyRate}元）、餐食${c.mealDays}天×${mealUnit}=${mealCost}元、已执行产康${c.recoveryDone}次×${recoveryUnit}=${recoveryCost}元、已发赠品折算${giftsValue}元、增项${extraCharge}元、押金${deposit}元；应退合计${totalRefund}元。`);
      planEvent(planId, user, "frozen", `套餐尾款${c.pkg.price}元已冻结：退款方案确认前停止追加费用与退款，护理主管需先核对护理动作。`);
      createException(stayId, "early_checkout", "产妇申请提前退所",
        `应出所${stay.expected_checkout}，拟${checkoutDate}提前${c.remaining}天退所。原因：${reason}。平台核对：已住${c.stayed}天/产康${c.recoveryDone}次/餐食${mealCost}元/赠品${giftsValue}元/押金${deposit}元，应退${totalRefund}元；套餐尾款已冻结，待护理主管核对护理动作。`,
        "high", user);
      audit(stayId, user, "提前退所核对", `已住${c.stayed}天/产康${c.recoveryDone}次/餐食${mealCost}元/赠品${giftsValue}元/押金${deposit}元，应退${totalRefund}元`);
      audit(stayId, user, "套餐尾款冻结", `冻结套餐尾款${c.pkg.price}元，退款方案#${planId}确认前不得追加费用或退款`);
      return { id: planId, message: `退款方案已生成并冻结套餐尾款，应退 ${totalRefund} 元；待护理主管核对护理动作` };
    },
  },

  // ---- 财务调整退款方案（仅护理主管核对前）----
  "refund_plans.update": {
    roles: ["finance", "admin"],
    run(user, p) {
      const plan = mustRefundPlan(num(p, "id"));
      if (String(plan.status) === "reviewed") throw new Error("退款方案已财务复核，不可调整");
      if (String(plan.status) !== "frozen") throw new Error("护理主管已核对/已同步家属，如需调整请先撤回方案");
      const stay = mustStay(Number(plan.stay_id));
      const mealUnit = num(p, "mealUnitCost", Number(plan.meal_unit_cost));
      const recoveryUnit = num(p, "recoveryUnitCost", Number(plan.recovery_unit_cost));
      const giftsValue = num(p, "giftsValue", Number(plan.gifts_delivered_value));
      const otherDeduction = num(p, "otherDeduction", Number(plan.other_deduction));
      const otherAdjustment = num(p, "otherAdjustment", Number(plan.other_adjustment));
      const mealCost = r2(Number(plan.meal_days) * mealUnit);
      const recoveryCost = r2(Number(plan.recovery_done_count) * recoveryUnit);
      const totalConsumed = r2(Number(plan.room_charge) + mealCost + recoveryCost + giftsValue
        + Number(plan.extra_charge) + otherDeduction);
      const totalRefund = r2(Number(plan.deposit_amount) + Number(plan.frozen_balance) - totalConsumed + otherAdjustment);
      run(`UPDATE refund_plans SET meal_unit_cost=?,meal_cost=?,recovery_unit_cost=?,recovery_cost=?,
            gifts_delivered_value=?,other_deduction=?,other_adjustment=?,adjustment_note=?,
            total_consumed=?,total_refund=?,updated_at=? WHERE id=?`,
        mealUnit, mealCost, recoveryUnit, recoveryCost, giftsValue, otherDeduction, otherAdjustment,
        str(p, "adjustmentNote", String(plan.adjustment_note || "")), totalConsumed, totalRefund, now(), Number(plan.id));
      planEvent(Number(plan.id), user, "adjusted",
        `财务调整：餐食${mealCost}元、产康${recoveryCost}元、赠品${giftsValue}元、其他扣减${otherDeduction}元、其他调整${otherAdjustment}元；调整后应退${totalRefund}元。${str(p, "adjustmentNote") ? "说明：" + str(p, "adjustmentNote") : ""}`);
      audit(Number(plan.stay_id), user, "退款方案调整", `调整后应退${totalRefund}元`);
      return { message: `已调整，应退 ${totalRefund} 元` };
    },
  },

  // ---- 撤回退款方案（解除冻结）----
  "refund_plans.cancel": {
    roles: ["finance", "admin"],
    run(user, p) {
      const plan = mustRefundPlan(num(p, "id"));
      if (String(plan.status) === "reviewed") throw new Error("退款方案已复核完成，不可撤回");
      run("UPDATE refund_plans SET status='cancelled', updated_at=? WHERE id=?", now(), Number(plan.id));
      run("UPDATE stays SET checkout_date=NULL WHERE id=?", Number(plan.stay_id));
      planEvent(Number(plan.id), user, "cancelled", `撤回退款方案，套餐尾款冻结解除。${str(p, "note") ? "原因：" + str(p, "note") : ""}`);
      audit(Number(plan.stay_id), user, "退款方案撤回", `方案#${plan.id}撤回，尾款冻结解除`);
      return { message: "已撤回退款方案，套餐尾款冻结解除" };
    },
  },

  // ---- 护理主管（护士长）核对护理动作并安排出所回访 ----
  "care.verify": {
    roles: ["head_nurse", "admin"],
    run(user, p) {
      const plan = mustRefundPlan(num(p, "planId"));
      if (String(plan.status) === "cancelled") throw new Error("退款方案已撤回");
      if (String(plan.status) === "reviewed") throw new Error("退款方案已复核完成");
      const stayId = Number(plan.stay_id);
      const taskDone = Number(q1("SELECT COUNT(*) AS c FROM care_tasks WHERE stay_id=? AND status='done'", stayId)?.c || 0);
      const taskPending = Number(q1("SELECT COUNT(*) AS c FROM care_tasks WHERE stay_id=? AND status='pending'", stayId)?.c || 0);
      const recCount = Number(q1("SELECT COUNT(*) AS c FROM care_records WHERE stay_id=?", stayId)?.c || 0);
      const schedDone = Number(plan.recovery_done_count);
      const mealDays = Number(plan.meal_days);
      const note = str(p, "careNote");
      const summary = `护理动作核对：已完成护理任务${taskDone}项（待执行${taskPending}项）、护理记录${recCount}条、已执行产康${schedDone}次、已供餐${mealDays}天，费用与服务记录一致。${note ? "核对说明：" + note : ""}`;
      run(`UPDATE refund_plans SET care_verified=1,care_verified_by=?,care_verified_at=?,care_note=?,
            status=CASE WHEN status='frozen' THEN 'care_verified' ELSE status END,updated_at=? WHERE id=?`,
        user.id, now(), summary, now(), Number(plan.id));
      planEvent(Number(plan.id), user, "care_verified", summary);
      // 出所回访同步生成（护理主管安排；重复核对不重复生成）
      if (Number(plan.care_verified) !== 1) {
        const co = String(plan.checkout_date);
        run("INSERT INTO follow_ups(stay_id,type,scheduled_at,content,created_by) VALUES(?,?,?,?,?)",
          stayId, "出所回访", addDays(co, 3) + " 10:00", `提前退所出所回访（${co}退所，第3天）：恢复情况、满意度、退款到账确认`, user.id);
        run("INSERT INTO follow_ups(stay_id,type,scheduled_at,content,created_by) VALUES(?,?,?,?,?)",
          stayId, "母婴随访", addDays(co, 30) + " 10:00", "出所后1个月母婴随访（儿保+产康复查提醒）", user.id);
        planEvent(Number(plan.id), user, "followup_arranged", "已安排出所回访（退所后第3天）与母婴随访（退所后第30天）。");
      }
      // 同步至提前退所异常工单
      const ex = q1("SELECT id FROM exceptions WHERE stay_id=? AND type='early_checkout' AND status IN ('open','processing') ORDER BY id DESC LIMIT 1", stayId);
      if (ex) {
        run("INSERT INTO exception_events(exception_id,user_id,user_name,action,note) VALUES(?,?,?,?,?)",
          Number(ex.id), user.id, user.name, "note", "护理主管已核对护理动作并安排出所回访，退款方案可同步家属。");
      }
      audit(stayId, user, "护理动作核对", `提前退所方案#${plan.id}：任务${taskDone}项/记录${recCount}条/产康${schedDone}次/餐${mealDays}天，已安排出所回访`);
      return { message: "护理动作已核对，出所回访已同步生成；财务可将退款方案同步家属端" };
    },
  },

  // ---- 退款方案确认前：同步家属端（前置：护理主管已核对）----
  "refund_plans.confirm": {
    roles: ["finance", "admin"],
    run(user, p) {
      const plan = mustRefundPlan(num(p, "id"));
      if (Number(plan.care_verified) !== 1) {
        throw new Error("护理主管尚未核对护理动作，退款方案不能同步家属（避免费用和服务记录脱节）");
      }
      if (!["care_verified", "disputed"].includes(String(plan.status))) throw new Error("当前方案状态不可同步家属");
      const stayId = Number(plan.stay_id);
      run("UPDATE refund_plans SET status='family_synced',family_status='pending',updated_at=? WHERE id=?", now(), Number(plan.id));
      const sign = Number(plan.total_refund) >= 0 ? "应退" : "应补";
      const text = `【提前退所退款方案】拟${plan.checkout_date}退所（原因：${plan.reason}）。已住${plan.stayed_days}天、剩余${plan.remaining_days}天；房型费用${plan.room_charge}元、餐食${plan.meal_cost}元、已执行产康${plan.recovery_cost}元、赠送服务折算${plan.gifts_delivered_value}元、押金${plan.deposit_amount}元；${sign} ${Math.abs(Number(plan.total_refund))} 元。套餐尾款已冻结，财务复核后退款到账。如有异议请在费用明细区提出。`;
      run("INSERT INTO messages(stay_id,from_user_id,from_name,from_role,audience,content) VALUES(?,?,?,?,?,?)",
        stayId, user.id, user.name, user.role, "family", text);
      planEvent(Number(plan.id), user, "family_synced", text);
      const ex = q1("SELECT id FROM exceptions WHERE stay_id=? AND type='early_checkout' AND status IN ('open','processing') ORDER BY id DESC LIMIT 1", stayId);
      if (ex) {
        run("INSERT INTO exception_events(exception_id,user_id,user_name,action,note) VALUES(?,?,?,?,?)",
          Number(ex.id), user.id, user.name, "note", "退款方案已同步家属端，待家属知悉/财务复核。");
      }
      audit(stayId, user, "退款方案同步", `方案#${plan.id}同步家属端，${sign}${Math.abs(Number(plan.total_refund))}元`);
      return { message: "退款方案已同步家属端，待家属知悉后财务复核" };
    },
  },

  // ---- 家属知悉 / 提出异议 ----
  "refund_plans.ack": {
    roles: ["family"],
    run(user, p) {
      const plan = mustRefundPlan(num(p, "id"));
      assertFamilyStay(user, Number(plan.stay_id));
      if (!["family_synced", "disputed"].includes(String(plan.status))) throw new Error("退款方案尚未同步");
      run("UPDATE refund_plans SET family_status='acked',family_ack_by=?,family_ack_at=?,family_note=?,updated_at=? WHERE id=?",
        user.id, now(), str(p, "note", "家属已知悉无异议"), now(), Number(plan.id));
      planEvent(Number(plan.id), user, "family_acked", str(p, "note", "家属已知悉无异议"));
      audit(Number(plan.stay_id), user, "家属知悉退款方案", `方案#${plan.id}家属确认知悉`);
      return { message: "已知悉，等待财务复核退款" };
    },
  },

  "refund_plans.dispute": {
    roles: ["family"],
    run(user, p) {
      const plan = mustRefundPlan(num(p, "id"));
      assertFamilyStay(user, Number(plan.stay_id));
      if (!["family_synced", "disputed"].includes(String(plan.status))) throw new Error("退款方案尚未同步");
      const why = req(p, "note", "异议原因");
      run("UPDATE refund_plans SET family_status='disputed',family_note=?,updated_at=? WHERE id=?", why, now(), Number(plan.id));
      run("UPDATE refund_plans SET status='disputed' WHERE id=?", Number(plan.id));
      planEvent(Number(plan.id), user, "family_disputed", why);
      createException(Number(plan.stay_id), "checkout_dispute", "家属对提前退所退款方案有异议",
        `退款方案#${plan.id}（应退${plan.total_refund}元）：家属提出异议：${why}。需护士长/财务核实处理后重新同步。`,
        "high", user);
      audit(Number(plan.stay_id), user, "退款异议", `家属对方案#${plan.id}提出异议：${why}`);
      return { message: "异议已提交，护士长与财务将核实处理" };
    },
  },

  // ---- 家属异议处理后重新同步（护士长/财务关闭异议）----
  "refund_plans.resolve_dispute": {
    roles: ["head_nurse", "finance", "admin"],
    run(user, p) {
      const plan = mustRefundPlan(num(p, "id"));
      if (String(plan.status) !== "disputed") throw new Error("方案当前无待处理异议");
      const note = req(p, "note", "处理说明");
      run("UPDATE refund_plans SET status='care_verified',family_status='pending',family_note=family_note,updated_at=? WHERE id=?",
        now(), Number(plan.id));
      planEvent(Number(plan.id), user, "dispute_resolved", `异议处理：${note}。退回财务重新同步家属。`);
      const ex = q1("SELECT id FROM exceptions WHERE stay_id=? AND type='checkout_dispute' AND status IN ('open','processing') ORDER BY id DESC LIMIT 1", Number(plan.stay_id));
      if (ex) {
        run("UPDATE exceptions SET status='resolved',resolution=?,resolved_at=?,updated_at=? WHERE id=?",
          note, now(), now(), Number(ex.id));
        run("INSERT INTO exception_events(exception_id,user_id,user_name,action,note) VALUES(?,?,?,?,?)",
          Number(ex.id), user.id, user.name, "resolved", note);
      }
      audit(Number(plan.stay_id), user, "退款异议处理", `方案#${plan.id}异议已处理：${note}`);
      return { message: "异议已处理，请财务重新同步家属端" };
    },
  },

  // ---- 财务复核退款：退款入账、办理出所、生成已确认结算单 ----
  "refund_plans.review": {
    roles: ["finance", "admin"],
    run(user, p) {
      const plan = mustRefundPlan(num(p, "id"));
      if (String(plan.status) === "cancelled") throw new Error("退款方案已撤回");
      if (String(plan.status) === "reviewed") throw new Error("退款方案已复核完成");
      if (Number(plan.care_verified) !== 1) throw new Error("护理主管尚未核对护理动作，不能复核");
      if (String(plan.status) !== "family_synced") throw new Error("退款方案尚未同步家属端，不能复核");
      if (String(plan.family_status) === "disputed") throw new Error("家属对方案有异议，请先处理异议");
      const stayId = Number(plan.stay_id);
      const stay = mustStay(stayId);
      const reviewNote = str(p, "reviewNote", "复核无误");
      const refundAmt = r2(Number(plan.total_refund));

      if (refundAmt > 0) {
        run("INSERT INTO fees(stay_id,type,direction,amount,description,created_by) VALUES(?,?,?,?,?,?)",
          stayId, "refund", "refund", refundAmt,
          `提前退所退款（押金${plan.deposit_amount}+套餐剩余${r2(Number(plan.frozen_balance) - Number(plan.room_charge))}-餐食${plan.meal_cost}-产康${plan.recovery_cost}-赠品${plan.gifts_delivered_value}${Number(plan.other_deduction) ? "-其他扣减" + plan.other_deduction : ""}${Number(plan.other_adjustment) ? "+调整" + plan.other_adjustment : ""}），方案#${plan.id}`,
          user.id);
      } else if (refundAmt < 0) {
        run("INSERT INTO fees(stay_id,type,direction,amount,description,created_by) VALUES(?,?,?,?,?,?)",
          stayId, "extra", "charge", r2(-refundAmt),
          `提前退所应补款项（已消费超押金），方案#${plan.id}`, user.id);
      }
      // 结算单（以全部已确认流水重算，复核即确认）
      const fees = q("SELECT * FROM fees WHERE stay_id=? AND status='confirmed'", stayId);
      const charge = fees.filter((f) => f.direction === "charge").reduce((s, f) => s + Number(f.amount), 0);
      const refundSum = fees.filter((f) => f.direction === "refund").reduce((s, f) => s + Number(f.amount), 0);
      const paid = r2(charge - refundSum);
      const refundText = refundAmt >= 0 ? "退款" + refundAmt + "元" : "应补" + r2(-refundAmt) + "元";
      const detail = `提前退所结算：${plan.checkout_date}退所（原因：${plan.reason}），已住${plan.stayed_days}天；房型${plan.room_charge}+餐食${plan.meal_cost}+产康${plan.recovery_cost}+赠品${plan.gifts_delivered_value}+增项${plan.extra_charge}${Number(plan.other_deduction) ? "+扣减" + plan.other_deduction : ""}=已消费${plan.total_consumed}；押金${plan.deposit_amount}元退还；${refundText}；复核：${reviewNote}`;
      run(`INSERT INTO settlements(stay_id,total_charge,total_refund,paid,balance,detail,status,confirmed_by,confirmed_at)
           VALUES(?,?,?,?,?,?,'confirmed',?,?)
           ON CONFLICT(stay_id) DO UPDATE SET total_charge=excluded.total_charge,total_refund=excluded.total_refund,
             paid=excluded.paid,balance=0,detail=excluded.detail,status='confirmed',confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at`,
        stayId, charge, refundSum, paid, detail, user.id, now());
      // 办理出所、释放房间
      run("UPDATE stays SET status='checked_out',actual_checkout=?,checkout_date=? WHERE id=?",
        String(plan.checkout_date), String(plan.checkout_date), stayId);
      run("UPDATE rooms SET status='cleaning' WHERE id=?", Number(stay.room_id));
      run("UPDATE refund_plans SET status='reviewed',review_status='approved',reviewed_by=?,reviewed_at=?,review_note=?,updated_at=? WHERE id=?",
        user.id, now(), reviewNote, now(), Number(plan.id));
      planEvent(Number(plan.id), user, "reviewed", `财务复核通过（${reviewNote}）：${refundAmt >= 0 ? "退款" + refundAmt + "元已生成退款流水" : "应补" + r2(-refundAmt) + "元"}，结算单已确认，已办理出所。`);
      // 关闭提前退所工单并通知家属
      const ex = q1("SELECT id FROM exceptions WHERE stay_id=? AND type='early_checkout' AND status IN ('open','processing') ORDER BY id DESC LIMIT 1", stayId);
      if (ex) {
        run("UPDATE exceptions SET status='resolved',resolution=?,resolved_at=?,updated_at=? WHERE id=?",
          `财务复核完成，${refundAmt >= 0 ? "退款" + refundAmt + "元" : "应补" + r2(-refundAmt) + "元"}，已出所。`, now(), now(), Number(ex.id));
        run("INSERT INTO exception_events(exception_id,user_id,user_name,action,note) VALUES(?,?,?,?,?)",
          Number(ex.id), user.id, user.name, "resolved", "财务复核退款完成，结算单已确认。");
      }
      run("INSERT INTO messages(stay_id,from_user_id,from_name,from_role,audience,content) VALUES(?,?,?,?,?,?)",
        stayId, user.id, user.name, user.role, "family",
        `【退款已复核】您的提前退所退款方案已财务复核通过，${refundAmt >= 0 ? "退款 " + refundAmt + " 元将按支付渠道退回" : "应补 " + r2(-refundAmt) + " 元"}，结算单已确认，出所手续已办结。出所回访时间为${plan.checkout_date}后第3天，请保持电话畅通。`);
      audit(stayId, user, "退款复核", `方案#${plan.id}复核通过，${refundAmt >= 0 ? "退款" + refundAmt + "元" : "应补" + r2(-refundAmt) + "元"}，结算确认并办理出所`);
      return { message: `财务复核完成：${refundAmt >= 0 ? "退款" + refundAmt + "元" : "应补" + r2(-refundAmt) + "元"}，已办理出所` };
    },
  },

  // ---- 结算确认（正常出所；提前退所以退款方案复核为准）----
  "settlements.confirm": {
    roles: ["finance", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const plan = activeRefundPlan(stayId);
      if (plan) throw new Error(`该房提前退所退款方案#${plan.id}处理中（尾款已冻结），请完成护理核对/家属同步/财务复核`);
      const s = q1("SELECT * FROM settlements WHERE stay_id=?", stayId);
      if (!s) throw new Error("结算单不存在，请先办理出所");
      const paid = num(p, "paid", Number(s.total_charge) - Number(s.total_refund));
      const balance = Number(s.total_charge) - Number(s.total_refund) - paid;
      run("UPDATE settlements SET paid=?, balance=?, status='confirmed', confirmed_by=?, confirmed_at=? WHERE stay_id=?",
        paid, balance, user.id, now(), stayId);
      audit(stayId, user, "结算确认", `实收${paid}，余额${balance}`);
      return { message: `结算已确认，余额 ${balance} 元` };
    },
  },
};

function getAffectedTasks(stayId: number, from: string, to: string): Row[] {
  return q(`SELECT * FROM care_tasks WHERE stay_id=? AND type='night_care' AND status='pending'
            AND substr(scheduled_at,1,10)>=? AND substr(scheduled_at,1,10)<=?`, stayId, from, to);
}

export function runAction(user: SessionUser, action: string, payload: Payload): unknown {
  const def = ACTIONS[action];
  if (!def) throw new Error(`未知操作：${action}`);
  if (!def.roles.includes(user.role)) throw new Error("当前角色无权执行该操作");
  return def.run(user, payload || {});
}

export function listActions(): string[] {
  return Object.keys(ACTIONS);
}
