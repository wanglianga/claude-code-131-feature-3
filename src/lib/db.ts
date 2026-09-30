// 数据库层：node:sqlite 单例 + schema + 种子数据
// SQL 均为标准语法，可平滑迁移到 MySQL（见 README）。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = process.env.MCARE_DB || path.join(DATA_DIR, "mcare.db");

export function hashPassword(password: string, salt: string): string {
  return crypto.createHash("sha256").update(salt + ":" + password).digest("hex");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  phone TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS rooms(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  floor TEXT DEFAULT '',
  status TEXT DEFAULT 'vacant'
);
CREATE TABLE IF NOT EXISTS packages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  days INTEGER NOT NULL,
  price REAL NOT NULL,
  room_type TEXT NOT NULL,
  includes TEXT DEFAULT '',
  gifts TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS stays(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  package_id INTEGER NOT NULL REFERENCES packages(id),
  mother_name TEXT NOT NULL,
  mother_phone TEXT DEFAULT '',
  delivery_method TEXT DEFAULT '',
  postpartum_days INTEGER DEFAULT 0,
  allergy_history TEXT DEFAULT '',
  feeding_method TEXT DEFAULT '',
  meal_taboos TEXT DEFAULT '',
  doctor_advice TEXT DEFAULT '',
  visit_permissions TEXT DEFAULT '{}',
  baby_name TEXT DEFAULT '',
  baby_weight REAL DEFAULT 0,
  jaundice_level REAL DEFAULT 0,
  jaundice_note TEXT DEFAULT '',
  status TEXT DEFAULT 'in_stay',
  check_in_date TEXT NOT NULL,
  expected_checkout TEXT NOT NULL,
  actual_checkout TEXT,
  checkout_date TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS family_links(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  relation TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS care_plans(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  frequency TEXT DEFAULT '',
  assignee_id INTEGER REFERENCES users(id),
  status TEXT DEFAULT 'active',
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS care_tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  plan_id INTEGER REFERENCES care_plans(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  assignee_id INTEGER REFERENCES users(id),
  status TEXT DEFAULT 'pending',
  done_at TEXT,
  done_by INTEGER,
  record TEXT DEFAULT '',
  visible_to_family INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS care_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  task_id INTEGER REFERENCES care_tasks(id),
  type TEXT DEFAULT '',
  content TEXT NOT NULL,
  created_by INTEGER,
  created_by_name TEXT DEFAULT '',
  visible_to_family INTEGER DEFAULT 1,
  disputed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS meals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  meal_date TEXT NOT NULL,
  meal_type TEXT NOT NULL,
  menu TEXT NOT NULL,
  taboo_hits TEXT DEFAULT '',
  status TEXT DEFAULT 'planned',
  note TEXT DEFAULT '',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS visits(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  visitor_name TEXT NOT NULL,
  relation TEXT DEFAULT '',
  visit_time TEXT NOT NULL,
  hours INTEGER DEFAULT 2,
  is_temp INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  disinfected INTEGER DEFAULT 0,
  disinfection_note TEXT DEFAULT '',
  approved_by INTEGER,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS fees(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  type TEXT NOT NULL,
  direction TEXT DEFAULT 'charge',
  amount REAL NOT NULL,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'confirmed',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS gifts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  name TEXT NOT NULL,
  source TEXT DEFAULT 'package',
  status TEXT DEFAULT 'pending',
  delivered_at TEXT,
  delivered_by INTEGER
);
CREATE TABLE IF NOT EXISTS therapist_schedules(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  therapist_id INTEGER REFERENCES users(id),
  project TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  status TEXT DEFAULT 'scheduled',
  delay_reason TEXT DEFAULT '',
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS hosting_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  baby_name TEXT DEFAULT '',
  type TEXT DEFAULT '托管',
  start_time TEXT NOT NULL,
  end_time TEXT,
  caregiver_id INTEGER,
  caregiver_name TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS doctor_rounds(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  doctor_id INTEGER,
  doctor_name TEXT DEFAULT '',
  round_date TEXT NOT NULL,
  findings TEXT DEFAULT '',
  advice TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS exceptions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  severity TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'open',
  raised_by INTEGER,
  raised_by_name TEXT DEFAULT '',
  assigned_role TEXT DEFAULT '',
  resolution TEXT DEFAULT '',
  synced_head_nurse INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS exception_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exception_id INTEGER NOT NULL REFERENCES exceptions(id),
  user_id INTEGER,
  user_name TEXT DEFAULT '',
  action TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS feedbacks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  user_id INTEGER,
  user_name TEXT DEFAULT '',
  rating INTEGER DEFAULT 5,
  content TEXT DEFAULT '',
  status TEXT DEFAULT 'new',
  response TEXT DEFAULT '',
  affect_scheduling INTEGER DEFAULT 0,
  handled_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS follow_ups(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  type TEXT DEFAULT '回访',
  scheduled_at TEXT NOT NULL,
  content TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  result TEXT DEFAULT '',
  created_by INTEGER,
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS referrals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  kind TEXT DEFAULT 'referral',
  lead_name TEXT NOT NULL,
  lead_phone TEXT DEFAULT '',
  note TEXT DEFAULT '',
  status TEXT DEFAULT 'new',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS settlements(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER UNIQUE NOT NULL REFERENCES stays(id),
  total_charge REAL DEFAULT 0,
  total_refund REAL DEFAULT 0,
  paid REAL DEFAULT 0,
  balance REAL DEFAULT 0,
  detail TEXT DEFAULT '',
  status TEXT DEFAULT 'draft',
  confirmed_by INTEGER,
  confirmed_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
-- 提前退所退款方案：平台核对已住天数/已执行产康/餐食成本/赠送服务/押金，冻结套餐尾款，护理主管核对后同步家属，财务复核退款
CREATE TABLE IF NOT EXISTS refund_plans(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER UNIQUE NOT NULL REFERENCES stays(id),
  reason TEXT DEFAULT '',
  checkout_date TEXT NOT NULL,
  stayed_days INTEGER DEFAULT 0,
  remaining_days INTEGER DEFAULT 0,
  daily_rate REAL DEFAULT 0,
  room_charge REAL DEFAULT 0,
  meal_days INTEGER DEFAULT 0,
  meal_unit_cost REAL DEFAULT 0,
  meal_cost REAL DEFAULT 0,
  recovery_done_count INTEGER DEFAULT 0,
  recovery_unit_cost REAL DEFAULT 0,
  recovery_cost REAL DEFAULT 0,
  gifts_delivered_value REAL DEFAULT 0,
  gifts_note TEXT DEFAULT '',
  deposit_amount REAL DEFAULT 0,
  extra_charge REAL DEFAULT 0,
  other_deduction REAL DEFAULT 0,
  other_adjustment REAL DEFAULT 0,
  adjustment_note TEXT DEFAULT '',
  frozen_balance REAL DEFAULT 0,
  total_consumed REAL DEFAULT 0,
  total_refund REAL DEFAULT 0,
  status TEXT DEFAULT 'draft',
  care_verified INTEGER DEFAULT 0,
  care_verified_by INTEGER,
  care_verified_at TEXT,
  care_note TEXT DEFAULT '',
  family_status TEXT DEFAULT 'pending',
  family_ack_by INTEGER,
  family_ack_at TEXT,
  family_note TEXT DEFAULT '',
  review_status TEXT DEFAULT 'pending',
  reviewed_by INTEGER,
  reviewed_at TEXT,
  review_note TEXT DEFAULT '',
  created_by INTEGER,
  created_by_name TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS refund_plan_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES refund_plans(id),
  user_id INTEGER,
  user_name TEXT DEFAULT '',
  action TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  from_user_id INTEGER,
  from_name TEXT DEFAULT '',
  from_role TEXT DEFAULT '',
  audience TEXT DEFAULT 'staff',
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS audit_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER REFERENCES stays(id),
  actor_id INTEGER,
  actor_name TEXT DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`;

type Row = Record<string, unknown>;

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  // 复用全局实例，避免 Next.js 开发模式热更新导致多开
  const g = globalThis as unknown as { __mcareDb?: DatabaseSync };
  if (g.__mcareDb) return g.__mcareDb;
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(SCHEMA);
  // 老库平滑迁移：stays.checkout_date（提前退所申请日期）
  const stayCols = db.prepare("PRAGMA table_info(stays)").all() as { name: string }[];
  if (!stayCols.some((c) => c.name === "checkout_date")) {
    db.exec("ALTER TABLE stays ADD COLUMN checkout_date TEXT");
  }
  const cnt = db.prepare("SELECT COUNT(*) AS c FROM users").get() as Row;
  if (Number(cnt.c) === 0) {
    seed(db);
  }
  g.__mcareDb = db;
  _db = db;
  return db;
}

export function q(sql: string, ...params: (string | number | null)[]): Row[] {
  return getDb().prepare(sql).all(...params) as Row[];
}
export function q1(sql: string, ...params: (string | number | null)[]): Row | undefined {
  return getDb().prepare(sql).get(...params) as Row | undefined;
}
export function run(sql: string, ...params: (string | number | null)[]): number {
  const r = getDb().prepare(sql).run(...params);
  return Number(r.lastInsertRowid);
}
export function now(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function today(): string {
  return now().slice(0, 10);
}
export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function seed(db: DatabaseSync) {
  const ins = (sql: string, ...params: (string | number | null)[]) =>
    db.prepare(sql).run(...params);
  const addAudit = (stayId: number | null, actorId: number | null, actor: string, action: string, detail: string, at: string | null = null) =>
    ins(`INSERT INTO audit_logs(stay_id,actor_id,actor_name,action,detail,created_at)
      VALUES(?,?,?,?,?,COALESCE(?,datetime('now','localtime')))`,
      stayId, actorId, actor, action, detail, at);

  // ---- 用户 ----
  const addUser = (username: string, password: string, name: string, role: string, phone = "") => {
    const salt = crypto.randomBytes(8).toString("hex");
    const r = ins(
      "INSERT INTO users(username,password_hash,salt,name,role,phone) VALUES(?,?,?,?,?,?)",
      username, hashPassword(password, salt), salt, name, role, phone
    );
    return Number(r.lastInsertRowid);
  };
  const admin = addUser("admin", "admin123", "沈总", "admin", "13800000001");
  const headNurse = addUser("headnurse", "head123", "周敏（护士长）", "head_nurse", "13800000002");
  const nurse1 = addUser("nurse1", "nurse123", "王芳（护理师）", "nurse", "13800000003");
  const nurse2 = addUser("nurse2", "nurse123", "李婷（护理师）", "nurse", "13800000004");
  const doctor = addUser("doctor", "doc123", "陈立（儿科医生）", "pediatrician", "13800000005");
  const nutrition = addUser("nutrition", "nut123", "赵芸（营养师）", "nutritionist", "13800000006");
  const therapist = addUser("therapist", "the123", "孙倩（产康师）", "therapist", "13800000007");
  const matron = addUser("matron", "mat123", "王嫂（月嫂）", "matron", "13800000008");
  const front = addUser("front", "front123", "小钱（前台）", "frontdesk", "13800000009");
  const finance = addUser("finance", "fin123", "吴会计（财务）", "finance", "13800000010");
  const family1 = addUser("family1", "family123", "张强（家属）", "family", "13911110001");
  const family2 = addUser("family2", "family123", "刘洋（家属）", "family", "13911110002");

  // ---- 房间 ----
  const addRoom = (number: string, type: string, floor: string, status = "vacant") =>
    Number(ins("INSERT INTO rooms(number,type,floor,status) VALUES(?,?,?,?)", number, type, floor, status).lastInsertRowid);
  const r801 = addRoom("801", "VIP套房", "8F", "occupied");
  const r802 = addRoom("802", "豪华间", "8F", "cleaning");
  addRoom("803", "VIP套房", "8F", "vacant");
  const r901 = addRoom("901", "标准间", "9F", "occupied");
  addRoom("902", "标准间", "9F", "vacant");
  addRoom("903", "标准间", "9F", "vacant");
  addRoom("601", "豪华间", "6F", "vacant");

  // ---- 套餐 ----
  const addPkg = (name: string, days: number, price: number, roomType: string, includes: string, gifts: string[]) =>
    Number(ins("INSERT INTO packages(name,days,price,room_type,includes,gifts) VALUES(?,?,?,?,?,?)",
      name, days, price, roomType, includes, JSON.stringify(gifts)).lastInsertRowid);
  const pkgClassic = addPkg("经典28天套餐", 28, 68800, "标准间",
    "每日三餐三点月子餐、每日查房、宝宝洗澡抚触、夜间照护、基础产康",
    ["待产大礼包", "宝宝艺术照"]);
  const pkgPremium = addPkg("尊享42天套餐", 42, 108800, "豪华间",
    "经典全部 + 乳房护理、产康课程12节、中药足浴、儿科医生每周巡诊",
    ["待产大礼包", "产康体验券", "满月照"]);
  const pkgVip = addPkg("至尊56天套餐", 56, 158800, "VIP套房",
    "尊享全部 + 一对一月嫂、产康课程20节、营养师定制餐、专车接送",
    ["待产大礼包", "产康体验券", "满月照", "金锁礼盒"]);

  // ---- 在住订单 A（801 张女士）----
  const stayA = Number(ins(
    `INSERT INTO stays(code,room_id,package_id,mother_name,mother_phone,delivery_method,postpartum_days,
      allergy_history,feeding_method,meal_taboos,doctor_advice,visit_permissions,
      baby_name,baby_weight,jaundice_level,jaundice_note,status,check_in_date,expected_checkout,created_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    "M20260913-801", r801, pkgPremium, "张丽", "13922220001",
    "剖宫产", 12, "青霉素过敏；海鲜过敏", "混合喂养",
    "忌辛辣、忌海鲜、少油", "注意伤口护理，每日监测黄疸，适当下床活动",
    JSON.stringify({ careSummary: true, fees: true, visits: true, visitors: ["张强（丈夫）", "李秀兰（婆婆）"] }),
    "小宝", 3.4, 12.9, "经皮胆红素偏高，持续观察", "in_stay",
    "2026-09-13", "2026-10-25", front
  ).lastInsertRowid);
  ins("INSERT INTO family_links(stay_id,user_id,name,relation) VALUES(?,?,?,?)", stayA, family1, "张强", "丈夫");

  // ---- 在住订单 B（901 刘女士）----
  const stayB = Number(ins(
    `INSERT INTO stays(code,room_id,package_id,mother_name,mother_phone,delivery_method,postpartum_days,
      allergy_history,feeding_method,meal_taboos,doctor_advice,visit_permissions,
      baby_name,baby_weight,jaundice_level,jaundice_note,status,check_in_date,expected_checkout,created_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    "M20260905-901", r901, pkgClassic, "刘敏", "13922220002",
    "顺产", 20, "无", "母乳喂养",
    "忌生冷", "加强盆底肌训练，注意营养均衡",
    JSON.stringify({ careSummary: true, fees: true, visits: true, visitors: ["刘洋（丈夫）"] }),
    "朵朵", 3.1, 8.2, "黄疸正常范围", "in_stay",
    "2026-09-05", "2026-10-03", front
  ).lastInsertRowid);
  ins("INSERT INTO family_links(stay_id,user_id,name,relation) VALUES(?,?,?,?)", stayB, family2, "刘洋", "丈夫");

  // ---- 已出所订单 C（802 王女士）----
  const stayC = Number(ins(
    `INSERT INTO stays(code,room_id,package_id,mother_name,mother_phone,delivery_method,postpartum_days,
      allergy_history,feeding_method,meal_taboos,doctor_advice,visit_permissions,
      baby_name,baby_weight,jaundice_level,jaundice_note,status,check_in_date,expected_checkout,actual_checkout,created_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    "M20260801-802", r802, pkgClassic, "王雪", "13922220003",
    "顺产", 5, "芒果过敏", "母乳喂养",
    "忌芒果、忌生冷", "正常休养",
    JSON.stringify({ careSummary: true, fees: true, visits: true, visitors: ["丈夫"] }),
    "豆豆", 3.3, 7.5, "正常", "checked_out",
    "2026-08-01", "2026-08-29", "2026-08-29", front
  ).lastInsertRowid);

  // ---- 护理计划（A）----
  const addPlan = (stayId: number, type: string, title: string, freq: string, assignee: number | null, note = "") =>
    Number(ins("INSERT INTO care_plans(stay_id,type,title,frequency,assignee_id,note) VALUES(?,?,?,?,?,?)",
      stayId, type, title, freq, assignee, note).lastInsertRowid);
  const pRounds = addPlan(stayA, "rounds", "护理查房", "每日2次", nurse1);
  const pWound = addPlan(stayA, "wound", "伤口观察（剖宫产）", "每日1次", nurse1, "观察切口愈合与渗液");
  const pBreast = addPlan(stayA, "breast", "乳房护理", "每日1次", nurse2, "预防乳腺堵塞");
  const pRecovery = addPlan(stayA, "recovery", "产康课程", "每周3次", therapist);
  const pMeal = addPlan(stayA, "meal", "月子餐", "每日三餐三点", nutrition, "忌辛辣海鲜");
  const pBath = addPlan(stayA, "baby_bath", "宝宝洗澡抚触", "每日1次", nurse2);
  const pNight = addPlan(stayA, "night_care", "夜间照护", "每日 20:00-08:00", matron);
  addPlan(stayB, "rounds", "护理查房", "每日2次", nurse2);
  addPlan(stayB, "breast", "乳房护理", "每日1次", nurse1);
  addPlan(stayB, "meal", "月子餐", "每日三餐三点", nutrition, "忌生冷");
  addPlan(stayB, "baby_bath", "宝宝洗澡抚触", "每日1次", nurse1);
  addPlan(stayB, "night_care", "夜间照护", "每日 20:00-08:00", matron);
  addPlan(stayB, "recovery", "盆底肌修复课程", "每周2次", therapist);

  // ---- 今日护理任务（A/B）----
  const addTask = (stayId: number, planId: number | null, type: string, title: string, at: string,
    assignee: number | null, status = "pending", record = "", visible = 1) =>
    Number(ins(`INSERT INTO care_tasks(stay_id,plan_id,type,title,scheduled_at,assignee_id,status,done_at,record,visible_to_family)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
      stayId, planId, type, title, at, assignee, status,
      status === "done" ? at : null, record, visible).lastInsertRowid);
  const t1 = addTask(stayA, pRounds, "rounds", "晨间查房", "2026-09-25 08:30", nurse1, "done", "体温36.7℃，血压正常，恶露量少。");
  const t2 = addTask(stayA, pWound, "wound", "伤口观察", "2026-09-25 09:00", nurse1, "done", "切口干燥无渗液，愈合良好。", 0);
  const t3 = addTask(stayA, pBreast, "breast", "乳房护理", "2026-09-25 10:00", nurse2, "done", "右侧轻微胀硬，已热敷按摩。");
  addTask(stayA, pMeal, "meal", "午餐配送与忌口核对", "2026-09-25 11:30", nutrition, "pending");
  addTask(stayA, pBath, "baby_bath", "宝宝洗澡抚触", "2026-09-25 15:00", nurse2, "pending");
  const tNight = addTask(stayA, pNight, "night_care", "夜间照护（9-24夜）", "2026-09-24 20:00", matron, "done", "夜间哺乳3次，宝宝睡眠安稳。");
  addTask(stayA, pRounds, "rounds", "晚间查房", "2026-09-25 20:30", nurse1, "pending");
  addTask(stayB, null, "rounds", "晨间查房", "2026-09-25 08:30", nurse2, "done", "一般情况好。");
  addTask(stayB, null, "baby_bath", "宝宝洗澡抚触", "2026-09-25 15:30", nurse1, "pending");
  addTask(stayB, null, "night_care", "夜间照护（9-25夜）", "2026-09-25 20:00", matron, "pending");

  // ---- 护理记录（A）----
  const addRecord = (stayId: number, taskId: number | null, type: string, content: string,
    by: number, byName: string, visible = 1, disputed = 0, at: string | null = null) =>
    Number(ins(`INSERT INTO care_records(stay_id,task_id,type,content,created_by,created_by_name,visible_to_family,disputed,created_at)
      VALUES(?,?,?,?,?,?,?,?,COALESCE(?, datetime('now','localtime')))`,
      stayId, taskId, type, content, by, byName, visible, disputed, at).lastInsertRowid);
  addRecord(stayA, t1, "rounds", "晨间查房：体温36.7℃，血压110/70，恶露量少色淡。", nurse1, "王芳（护理师）", 1, 0, "2026-09-25 08:40:00");
  addRecord(stayA, t2, "wound", "伤口观察：剖宫产切口干燥，无红肿渗液，换药一次。", nurse1, "王芳（护理师）", 0, 0, "2026-09-25 09:10:00");
  addRecord(stayA, t3, "breast", "乳房护理：右侧外上象限轻胀硬，热敷+手法疏通15分钟，嘱多亲喂。", nurse2, "李婷（护理师）", 1, 0, "2026-09-25 10:20:00");
  addRecord(stayA, tNight, "night_care", "夜间照护：哺乳3次，换尿布4次，宝宝23:00-05:00连续睡眠。", matron, "王嫂（月嫂）", 1, 1, "2026-09-25 08:00:00");
  addRecord(stayA, null, "baby", "宝宝经皮胆红素测定12.9mg/dL，较前上升，已报儿科医生。", nurse1, "王芳（护理师）", 1, 0, "2026-09-25 09:30:00");

  // ---- 月子餐 ----
  const addMeal = (stayId: number, date: string, type: string, menu: string, hits = "", status = "confirmed", note = "") =>
    Number(ins("INSERT INTO meals(stay_id,meal_date,meal_type,menu,taboo_hits,status,note,created_by) VALUES(?,?,?,?,?,?,?,?)",
      stayId, date, type, menu, hits, status, note, nutrition).lastInsertRowid);
  addMeal(stayA, "2026-09-25", "早餐", "小米南瓜粥、蒸蛋羹、全麦馒头、温牛奶");
  addMeal(stayA, "2026-09-25", "午餐", "山药排骨汤、清蒸鲈鱼、时蔬、软米饭");
  addMeal(stayA, "2026-09-25", "晚餐", "虾仁滑蛋、菠菜猪肝汤、软米饭", "海鲜（虾仁）", "issue", "家属反馈产妇海鲜过敏，已登记异常");
  addMeal(stayB, "2026-09-25", "午餐", "当归鸡汤、清炒时蔬、杂粮饭");
  addMeal(stayB, "2026-09-25", "晚餐", "鲫鱼豆腐汤、西兰花、软米饭");

  // ---- 探访 ----
  const addVisit = (stayId: number, name: string, relation: string, time: string, hours: number,
    isTemp: number, status: string, disinfected = 0, note = "") =>
    Number(ins(`INSERT INTO visits(stay_id,visitor_name,relation,visit_time,hours,is_temp,status,disinfected,disinfection_note,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
      stayId, name, relation, time, hours, isTemp, status, disinfected, note, family1).lastInsertRowid);
  addVisit(stayA, "李秀兰", "婆婆", "2026-09-25 10:00", 2, 0, "completed", 1, "入所前手部消毒+测温正常");
  addVisit(stayA, "张强", "丈夫", "2026-09-26 14:00", 3, 0, "approved");
  addVisit(stayB, "刘洋", "丈夫", "2026-09-25 19:00", 2, 1, "pending");

  // ---- 费用 ----
  const addFee = (stayId: number, type: string, amount: number, desc: string, direction = "charge", by: number = finance, at: string | null = null) =>
    Number(ins(`INSERT INTO fees(stay_id,type,direction,amount,description,status,created_by,created_at)
      VALUES(?,?,?,?,?,'confirmed',?,COALESCE(?, datetime('now','localtime')))`,
      stayId, type, direction, amount, desc, by, at).lastInsertRowid);
  addFee(stayA, "package", 108800, "尊享42天套餐费用", "charge", finance, "2026-09-13 10:00:00");
  addFee(stayA, "deposit", 10000, "入住押金", "charge", finance, "2026-09-13 10:00:00");
  addFee(stayA, "extra", 380, "中药足浴（9-20）", "charge", finance, "2026-09-20 15:00:00");
  addFee(stayA, "extra", 580, "宝宝满月照加拍", "charge", finance, "2026-09-24 11:00:00");
  addFee(stayB, "package", 68800, "经典28天套餐费用", "charge", finance, "2026-09-05 09:00:00");
  addFee(stayB, "deposit", 8000, "入住押金", "charge", finance, "2026-09-05 09:00:00");
  addFee(stayC, "package", 68800, "经典28天套餐费用", "charge", finance, "2026-08-01 09:00:00");
  addFee(stayC, "deposit", 8000, "入住押金", "charge", finance, "2026-08-01 09:00:00");
  addFee(stayC, "extra", 1280, "产康加项（骨盆修复2次）", "charge", finance, "2026-08-15 10:00:00");
  addFee(stayC, "refund", 8000, "出所退还押金", "refund", finance, "2026-08-29 15:00:00");

  // ---- 赠品 ----
  const addGift = (stayId: number, name: string, status: string, at: string | null = null) =>
    Number(ins("INSERT INTO gifts(stay_id,name,source,status,delivered_at,delivered_by) VALUES(?,?,?,?,?,?)",
      stayId, name, "package", status, at, status === "delivered" ? front : null).lastInsertRowid);
  addGift(stayA, "待产大礼包", "delivered", "2026-09-13 11:00:00");
  addGift(stayA, "产康体验券", "pending");
  addGift(stayA, "满月照", "pending");
  addGift(stayB, "待产大礼包", "delivered", "2026-09-05 10:00:00");
  addGift(stayB, "宝宝艺术照", "pending");

  // ---- 产康排班 ----
  const addSched = (stayId: number, therapistId: number, project: string, at: string, status = "scheduled", reason = "") =>
    Number(ins("INSERT INTO therapist_schedules(stay_id,therapist_id,project,scheduled_at,status,delay_reason) VALUES(?,?,?,?,?,?)",
      stayId, therapistId, project, at, status, reason).lastInsertRowid);
  addSched(stayA, therapist, "盆底肌修复（第3节）", "2026-09-26 10:00");
  addSched(stayA, therapist, "腹直肌修复（第2节）", "2026-09-28 10:00");
  addSched(stayB, therapist, "盆底肌修复（第1节）", "2026-09-24 14:00", "delayed", "产康师临时外出培训，改期至9-27");
  addSched(stayB, therapist, "盆底肌修复（第1节·改期完成）", "2026-09-27 14:00", "done");
  addSched(stayB, therapist, "腹直肌修复（第1节）", "2026-09-28 10:00", "done");

  // ---- 宝宝托管日志 ----
  const addHosting = (stayId: number, baby: string, type: string, start: string, end: string | null, cgId: number, cgName: string, notes: string) =>
    Number(ins("INSERT INTO hosting_logs(stay_id,baby_name,type,start_time,end_time,caregiver_id,caregiver_name,notes) VALUES(?,?,?,?,?,?,?,?)",
      stayId, baby, type, start, end, cgId, cgName, notes).lastInsertRowid);
  addHosting(stayA, "小宝", "夜间托管", "2026-09-24 20:00", "2026-09-25 08:00", matron, "王嫂（月嫂）", "夜间哺乳3次，睡眠安稳");
  addHosting(stayA, "小宝", "洗澡抚触", "2026-09-24 15:00", "2026-09-24 15:40", nurse2, "李婷（护理师）", "水温38℃，抚触15分钟，宝宝配合");
  addHosting(stayB, "朵朵", "托管", "2026-09-25 09:00", "2026-09-25 11:00", nurse1, "王芳（护理师）", "产妇休息时宝宝托管观察");

  // ---- 医生巡诊 ----
  const addRound = (stayId: number, date: string, findings: string, advice: string) =>
    Number(ins("INSERT INTO doctor_rounds(stay_id,doctor_id,doctor_name,round_date,findings,advice) VALUES(?,?,?,?,?,?)",
      stayId, doctor, "陈立（儿科医生）", date, findings, advice).lastInsertRowid);
  addRound(stayA, "2026-09-24", "宝宝经皮胆红素12.9mg/dL，精神吃奶可；产妇切口愈合良好。", "继续监测黄疸每日2次，必要时蓝光治疗；加强喂养。");
  addRound(stayB, "2026-09-23", "宝宝黄疸8.2mg/dL正常，脐部干燥。", "常规护理，按时接种疫苗。");

  // ---- 异常事件 ----
  const addException = (stayId: number, type: string, title: string, desc: string, severity: string,
    status: string, raisedBy: number, raisedName: string, assignedRole: string,
    syncedHeadNurse = 0, resolution = "", at: string | null = null) =>
    Number(ins(`INSERT INTO exceptions(stay_id,type,title,description,severity,status,raised_by,raised_by_name,assigned_role,synced_head_nurse,resolution,created_at,updated_at,resolved_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,datetime('now','localtime')),COALESCE(?,datetime('now','localtime')),?)`,
      stayId, type, title, desc, severity, status, raisedBy, raisedName, assignedRole, syncedHeadNurse,
      resolution, at, at, status === "resolved" || status === "closed" ? at : null).lastInsertRowid);
  const addEvent = (exId: number, userId: number, userName: string, action: string, note: string, at: string | null = null) =>
    ins(`INSERT INTO exception_events(exception_id,user_id,user_name,action,note,created_at)
      VALUES(?,?,?,?,?,COALESCE(?,datetime('now','localtime')))`,
      exId, userId, userName, action, note, at);

  const ex1 = addException(stayA, "jaundice", "宝宝黄疸值升至12.9mg/dL", "晨间测定经皮胆红素12.9mg/dL，较前日11.2上升，需儿科评估。", "high", "processing", nurse1, "王芳（护理师）", "pediatrician", 1, "", "2026-09-25 09:35:00");
  addEvent(ex1, nurse1, "王芳（护理师）", "created", "晨测黄疸升高，上报儿科医生并同步护士长。", "2026-09-25 09:35:00");
  addEvent(ex1, doctor, "陈立（儿科医生）", "accepted", "已查看宝宝，建议加强喂养、日光照射，下午复测，必要时蓝光。", "2026-09-25 10:10:00");

  const ex2 = addException(stayA, "meal_taboo", "晚餐含虾仁，与忌口（海鲜）冲突", "家属发现晚餐虾仁滑蛋含海鲜，产妇海鲜过敏，立即停止食用并更换。", "high", "open", family1, "张强（家属）", "nutritionist", 1, "", "2026-09-25 18:05:00");
  addEvent(ex2, family1, "张强（家属）", "created", "晚餐发现虾仁，产妇海鲜过敏，请中心核实处理。", "2026-09-25 18:05:00");

  const ex3 = addException(stayA, "record_dispute", "家属质疑9-24夜间照护记录", "家属认为夜间照护记录中哺乳次数与实际不符，要求核查监控与当班月嫂。", "high", "open", family1, "张强（家属）", "head_nurse", 1, "", "2026-09-25 09:00:00");
  addEvent(ex3, family1, "张强（家属）", "created", "对9-24夜间照护记录真实性提出质疑。", "2026-09-25 09:00:00");

  const ex4 = addException(stayB, "matron_leave", "月嫂王嫂申请9-26至9-27事假", "月嫂家中有事申请两天假，需安排夜间照护替班。", "medium", "processing", matron, "王嫂（月嫂）", "head_nurse", 1, "", "2026-09-25 08:30:00");
  addEvent(ex4, matron, "王嫂（月嫂）", "created", "申请9-26、9-27事假两天。", "2026-09-25 08:30:00");
  addEvent(ex4, headNurse, "周敏（护士长）", "accepted", "已知悉，正在协调替班月嫂。", "2026-09-25 09:00:00");

  const ex5 = addException(stayB, "project_delay", "盆底肌修复课程延期", "产康师9-24外出培训，课程改期至9-27 14:00。", "low", "resolved", therapist, "孙倩（产康师）", "therapist", 0, "已与产妇沟通改期至9-27 14:00，家属知悉。", "2026-09-24 13:00:00");
  addEvent(ex5, therapist, "孙倩（产康师）", "created", "因培训需延期课程。", "2026-09-24 13:00:00");
  addEvent(ex5, therapist, "孙倩（产康师）", "resolved", "已改期并通知产妇。", "2026-09-24 15:00:00");

  const ex6 = addException(stayC, "checkout_dispute", "退所押金结算争议", "家属对产康加项费用1280元有异议，认为未提前告知价格。", "high", "resolved", admin, "沈总", "finance", 1, "核实价目表已公示，考虑客户体验减免640元，家属接受。", "2026-08-29 14:00:00");
  addEvent(ex6, admin, "沈总", "created", "退所结算时家属对加项费用提出异议。", "2026-08-29 14:00:00");
  addEvent(ex6, finance, "吴会计（财务）", "note", "提供价目公示照片与签字确认单。", "2026-08-29 14:30:00");
  addEvent(ex6, headNurse, "周敏（护士长）", "resolved", "减免50%加项费用，家属签字确认，争议关闭。", "2026-08-29 15:00:00");

  // ---- 家属反馈 ----
  const addFeedback = (stayId: number, userId: number | null, userName: string, rating: number, content: string,
    status = "new", response = "", affect = 0, at: string | null = null) =>
    Number(ins(`INSERT INTO feedbacks(stay_id,user_id,user_name,rating,content,status,response,affect_scheduling,created_at)
      VALUES(?,?,?,?,?,?,?,?,COALESCE(?,datetime('now','localtime')))`,
      stayId, userId, userName, rating, content, status, response, affect, at).lastInsertRowid);
  addFeedback(stayA, family1, "张强（家属）", 4, "整体满意，希望夜间呼叫响应再快一些。", "new", "", 0, "2026-09-24 20:00:00");
  addFeedback(stayB, family2, "刘洋（家属）", 2, "月子餐出现过忌口食材，对餐饮不放心，希望更换配餐责任人。", "responded", "非常抱歉，已核对配餐流程并更换责任营养师，今日起每餐双人核对忌口。", 1, "2026-09-23 19:00:00");
  addFeedback(stayC, null, "王雪（家属）", 5, "28天体验很好，月嫂和护士都很专业，已推荐给朋友。", "responded", "感谢认可，已为您登记转介绍礼遇。", 0, "2026-08-29 16:00:00");

  // ---- 随访 / 回访 ----
  const addFollowUp = (stayId: number, type: string, at: string, content: string, status = "pending", result = "") =>
    Number(ins("INSERT INTO follow_ups(stay_id,type,scheduled_at,content,status,result,created_by,done_at) VALUES(?,?,?,?,?,?,?,?)",
      stayId, type, at, content, status, result, headNurse, status === "done" ? at : null).lastInsertRowid);
  addFollowUp(stayC, "回访", "2026-09-01 10:00", "出所后3天电话回访", "done", "产妇恢复良好，宝宝黄疸已退，对服务满意。");
  addFollowUp(stayC, "母婴随访", "2026-09-29 10:00", "出所后1个月母婴随访（儿保+产康复查提醒）");
  addFollowUp(stayA, "回访", "2026-09-28 10:00", "住中满意度回访");

  // ---- 复购 / 转介绍线索 ----
  const addReferral = (stayId: number, kind: string, name: string, phone: string, note: string, status = "new") =>
    Number(ins("INSERT INTO referrals(stay_id,kind,lead_name,lead_phone,note,status) VALUES(?,?,?,?,?,?)",
      stayId, kind, name, phone, note, status).lastInsertRowid);
  addReferral(stayC, "referral", "赵女士", "13933330001", "王女士转介绍，孕24周，意向42天套餐", "following");
  addReferral(stayC, "repurchase", "王雪", "13922220003", "咨询二胎月子房老客优惠", "new");

  // ---- 结算单（C 已确认）----
  ins(`INSERT INTO settlements(stay_id,total_charge,total_refund,paid,balance,detail,status,confirmed_by,confirmed_at)
    VALUES(?,?,?,?,?,?,?,?,?)`,
    stayC, 70080, 8000, 70080, 0,
    "套餐68800 + 产康加项1280 - 争议减免640 = 应收69440；押金8000退还；实收70080（含押金抵扣）",
    "confirmed", finance, "2026-08-29 15:30:00");

  // ---- 提前退所退款方案（B 901 进行中：家庭原因，财务已核对+冻结尾款，待护理主管核对护理动作）----
  ins("UPDATE stays SET checkout_date=? WHERE id=?", "2026-09-30", stayB);
  const ex7 = addException(stayB, "early_checkout", "产妇申请提前退所（家庭原因）",
    "应出所2026-10-03，拟2026-09-30提前退所（家庭原因）。平台核对已住天数、已执行产康、餐食成本、赠送服务与押金，退款方案生成中。",
    "high", "open", family2, "刘洋（家属）", "finance", 1, "", "2026-09-30 08:50:00");
  addEvent(ex7, family2, "刘洋（家属）", "created", "因家庭原因需提前3天退所，请协助办理退款。", "2026-09-30 08:50:00");
  addEvent(ex7, finance, "吴会计（财务）", "accepted", "已发起退款核对并冻结套餐尾款，待护理主管核对护理动作后同步家属。", "2026-09-30 09:10:00");

  const planB = Number(ins(
    `INSERT INTO refund_plans(stay_id,reason,checkout_date,stayed_days,remaining_days,daily_rate,room_charge,
      meal_days,meal_unit_cost,meal_cost,recovery_done_count,recovery_unit_cost,recovery_cost,
      gifts_delivered_value,gifts_note,deposit_amount,extra_charge,other_deduction,other_adjustment,adjustment_note,
      frozen_balance,total_consumed,total_refund,status,care_verified,family_status,review_status,created_by,created_by_name,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    stayB, "家庭原因需提前回乡", "2026-09-30", 25, 3, 2457.14, 61429,
    25, 120, 3000, 2, 380, 760,
    300, "待产大礼包已发放（折算300元）；宝宝艺术照待发放，随退所核销不收费", 8000, 0, 0, 0, "",
    68800, 65489, 11311, "frozen", 0, "pending", "pending", finance, "吴会计（财务）",
    "2026-09-30 09:05:00", "2026-09-30 09:05:00"
  ).lastInsertRowid);
  const addPlanEvent = (action: string, note: string, userId: number, userName: string, at: string) =>
    ins("INSERT INTO refund_plan_events(plan_id,user_id,user_name,action,note,created_at) VALUES(?,?,?,?,?,?)",
      planB, userId, userName, action, note, at);
  addPlanEvent("created", "产妇家庭原因申请提前退所，拟2026-09-30退所；平台开始核对已住天数、已执行产康、餐食成本、赠送服务与押金。", finance, "吴会计（财务）", "2026-09-30 09:05:00");
  addPlanEvent("calculated", "核对：已住25天（房价61429元）、餐食25天×120=3000元、已执行产康2次×380=760元、已发赠品折算300元、押金8000元；应退合计11311元。", finance, "吴会计（财务）", "2026-09-30 09:05:00");
  addPlanEvent("frozen", "套餐尾款68800元已冻结：退款方案确认前停止追加费用与退款，护理主管需先核对护理动作。", finance, "吴会计（财务）", "2026-09-30 09:05:00");
  addAudit(stayB, finance, "提前退所核对", "901产妇家庭原因提前退所：已住25天/产康2次/餐食3000元/赠品300元/押金8000元，应退11311元", "2026-09-30 09:05:00");
  addAudit(stayB, finance, "套餐尾款冻结", "冻结901套餐尾款68800元，退款方案确认前不得追加费用或退款", "2026-09-30 09:05:00");

  // ---- 家属沟通 ----
  const addMessage = (stayId: number, userId: number | null, name: string, role: string, audience: string, content: string, at: string | null = null) =>
    ins(`INSERT INTO messages(stay_id,from_user_id,from_name,from_role,audience,content,created_at)
      VALUES(?,?,?,?,?,?,COALESCE(?,datetime('now','localtime')))`,
      stayId, userId, name, role, audience, content, at);
  addMessage(stayA, front, "小钱（前台）", "frontdesk", "all", "已为您预约9-26 10:00盆底肌修复课程。", "2026-09-24 16:00:00");
  addMessage(stayA, family1, "张强（家属）", "family", "staff", "请问明天下午可以增加一次探访吗？孩子奶奶想来看看。", "2026-09-25 09:20:00");
  addMessage(stayB, family2, "刘洋（家属）", "family", "staff", "今晚我下班后想临时过来看一下，大概19:00到。", "2026-09-25 12:00:00");

  addAudit(stayA, front, "小钱（前台）", "入住登记", "张丽入住801（尊享42天套餐），建立护理计划7项", "2026-09-13 10:00:00");
  addAudit(stayA, finance, "吴会计（财务）", "费用登记", "套餐费用108800元、押金10000元", "2026-09-13 10:05:00");
  addAudit(stayA, nurse1, "王芳（护理师）", "护理记录", "晨间查房完成，宝宝黄疸复测12.9mg/dL", "2026-09-25 09:35:00");
  addAudit(stayA, family1, "张强（家属）", "家属沟通", "家属申请增加探访并质疑夜间照护记录", "2026-09-25 09:20:00");
  addAudit(stayB, matron, "王嫂（月嫂）", "月嫂请假", "申请9-26至9-27事假，待护士长协调替班", "2026-09-25 08:30:00");
  addAudit(stayC, finance, "吴会计（财务）", "出所结算", "结算完成：应收69440，退还押金8000，无欠费", "2026-08-29 15:30:00");

  console.log("[db] seeded demo data");
}
