// 冒烟测试：登录各角色 → 访问工作台 → 执行关键业务动作
// 用法：先启动服务（npm start 或 npm run dev），再执行 npm run smoke
const BASE = process.env.SMOKE_BASE || "http://localhost:3000";

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "login", username, password }),
  });
  const body = await res.json();
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return { ok: body.ok, cookie, user: body.user };
}

async function get(path, cookie) {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie }, redirect: "manual" });
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get("location") || "" };
}

async function doAction(cookie, payload) {
  const res = await fetch(`${BASE}/api/do`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(payload),
  });
  return res.json();
}

console.log(`smoke against ${BASE}`);

// 1. 登录页可访问
{
  const r = await get("/login", "");
  check("登录页可访问", r.status === 200 && r.text.includes("悦安月子中心"));
}

// 2. 错误密码被拒绝
{
  const r = await login("admin", "wrong-password");
  check("错误密码拒绝登录", r.ok === false);
}

// 3. 各角色登录并进入工作台
const roles = [
  ["admin", "admin123", "/admin", "房间实时看板"],
  ["headnurse", "head123", "/headnurse", "异常工单中心"],
  ["nurse1", "nurse123", "/nurse", "护理任务"],
  ["doctor", "doc123", "/doctor", "黄疸预警"],
  ["nutrition", "nut123", "/nutritionist", "忌口"],
  ["therapist", "the123", "/therapist", "产康排班"],
  ["matron", "mat123", "/nurse", "月嫂工作台"],
  ["front", "front123", "/frontdesk", "入住登记"],
  ["finance", "fin123", "/finance", "结算单"],
  ["family1", "family123", "/family", "护理摘要"],
];
const cookies = {};
for (const [u, p, home, marker] of roles) {
  const r = await login(u, p);
  check(`${u} 登录`, r.ok === true);
  if (!r.ok) continue;
  cookies[u] = r.cookie;
  const page = await get(home, r.cookie);
  check(`${u} 工作台 ${home} 含「${marker}」`, page.status === 200 && page.text.includes(marker));
}

// 4. 未登录访问受保护页 → 重定向登录
{
  const r = await get("/admin", "");
  check("未登录访问 /admin 重定向", r.status === 307 && r.location.includes("/login"));
}

// 5. 越权访问：家属访问管理看板 → 重定向家属端
{
  const r = await get("/admin", cookies["family1"]);
  check("家属访问 /admin 被重定向", r.status === 307 && r.location.includes("/family"));
}

// 6. 房间360视图（管理员）
{
  const r = await get("/stays/1", cookies["admin"]);
  check("房间360视图含产妇档案与异常工单", r.status === 200 && r.text.includes("产妇与宝宝档案") && r.text.includes("异常工单"));
}

// 7. 护理师完成一项任务
{
  const list = await get("/nurse", cookies["nurse1"]);
  const m = list.text.match(/宝宝洗澡抚触/);
  check("护理师任务列表含待执行任务", !!m);
  // 找一个 pending 任务 id：直接创建再完成
  const c = await doAction(cookies["nurse1"], { action: "tasks.create", stayId: 1, type: "rounds", title: "冒烟测试任务", scheduledAt: "2026-09-25 21:00" });
  check("护理师创建任务", c.ok === true);
  const done = await doAction(cookies["nurse1"], { action: "tasks.update", id: c.id, status: "done", record: "冒烟测试执行记录" });
  check("护理师完成任务并留记录", done.ok === true);
}

// 8. 营养师配餐命中忌口 → 自动建异常
{
  const r = await doAction(cookies["nutrition"], { action: "meals.create", stayId: 1, mealDate: "2026-09-26", mealType: "午餐", menu: "麻辣香锅、虾仁炒饭" });
  check("配餐命中忌口返回警告", r.ok === true && Array.isArray(r.tabooHits) && r.tabooHits.length > 0, JSON.stringify(r));
}

// 9. 家属预约临时探访 → 产生临时探访异常
{
  const r = await doAction(cookies["family1"], { action: "visits.create", stayId: 1, visitorName: "张强", relation: "丈夫", visitTime: "2026-09-26 18:00", hours: 2, isTemp: true });
  check("家属临时探访预约", r.ok === true);
  const admin = await get("/stays/1", cookies["admin"]);
  check("房间360出现临时探访异常", admin.text.includes("家属临时增加探访"));
}

// 10. 家属质疑护理记录
{
  const rec = await doAction(cookies["family1"], { action: "records.dispute", id: 1, reason: "冒烟测试：质疑记录" });
  check("家属质疑护理记录", rec.ok === true);
}

// 11. 家属越权访问他人房间
{
  const r = await doAction(cookies["family1"], { action: "visits.create", stayId: 2, visitorName: "越权测试", visitTime: "2026-09-26 20:00" });
  check("家属访问他人房间被拒绝", r.ok === false);
}

// 12. 前台登记新入住（含家属账号）——动态选取空房，可重复运行
let smokeStayId = null;
let smokeRoomId = null;
{
  const roomsRes = await fetch(`${BASE}/api/rooms`, { headers: { Cookie: cookies["front"] } });
  const roomsBody = await roomsRes.json();
  const vacant = (roomsBody.rooms || []).find((r) => r.status === "vacant");
  check("获取空房列表", !!vacant);
  if (vacant) {
    smokeRoomId = vacant.id;
    const r = await doAction(cookies["front"], {
      action: "stays.create", roomId: vacant.id, packageId: 1, motherName: "冒烟测试产妇", motherPhone: "13900000000",
      checkInDate: "2026-09-25", deliveryMethod: "顺产", postpartumDays: 3, feedingMethod: "母乳喂养",
      mealTaboos: "忌辛辣", babyName: "测测", babyWeight: 3.2, deposit: 5000,
      familyUsername: "smokefam", familyPassword: "smoke123", familyName: "冒烟家属", familyRelation: "丈夫",
    });
    check("前台入住登记", r.ok === true, JSON.stringify(r));
    if (r.ok) {
      smokeStayId = r.id;
      const fam = await login("smokefam", "smoke123");
      check("新家属账号可登录", fam.ok === true);
      cookies["smokefam"] = fam.cookie;
      const page = await get("/family", fam.cookie);
      check("新家属端显示入住信息", page.status === 200 && page.text.includes("冒烟测试产妇"));
    }
  }
}

// 13. 提前退所完整结算流程：发起核对→冻结套餐尾款→护理核对拦截→护士长核对+出所回访→家属同步→异议/知悉→财务复核出所
if (smokeStayId) {
  const stays = await get("/finance", cookies["finance"]);
  check("财务工作台含提前退所结算区", stays.status === 200 && stays.text.includes("提前退所结算"));
  const fee = await doAction(cookies["finance"], { action: "fees.create", stayId: smokeStayId, type: "extra", direction: "charge", amount: 100, description: "冒烟测试增项" });
  check("财务登记增项费用（冻结前）", fee.ok === true);

  // 旧的直接办理提前退所入口应被引导到新流程
  const coOld = await doAction(cookies["finance"], { action: "stays.checkout", stayId: smokeStayId, reason: "冒烟测试提前退所" });
  check("提前退所不再走旧的直接出所入口", coOld.ok === false && String(coOld.error).includes("退款方案"));

  // 财务发起退款方案：核对已住天数/产康/餐食/赠品/押金，冻结套餐尾款
  const plan = await doAction(cookies["finance"], {
    action: "refund_plans.create", stayId: smokeStayId, checkoutDate: "2026-09-26", reason: "冒烟测试家庭原因提前退所",
    mealUnitCost: 120, recoveryUnitCost: 380, giftUnitValue: 300,
  });
  check("发起退款方案并冻结套餐尾款", plan.ok === true && plan.id > 0, JSON.stringify(plan));
  const planId = plan.id;

  // 冻结期：追加费用、确认结算均被拦截
  const feeFrozen = await doAction(cookies["finance"], { action: "fees.create", stayId: smokeStayId, type: "extra", direction: "charge", amount: 50, description: "冻结期加项" });
  check("尾款冻结期禁止追加费用", feeFrozen.ok === false && String(feeFrozen.error).includes("冻结"));
  const settleFrozen = await doAction(cookies["finance"], { action: "settlements.confirm", stayId: smokeStayId });
  check("尾款冻结期禁止直接确认结算", settleFrozen.ok === false);

  // 护理主管未核对前，财务不能同步家属
  const syncEarly = await doAction(cookies["finance"], { action: "refund_plans.confirm", id: planId });
  check("护理未核对时同步家属被拦截", syncEarly.ok === false && String(syncEarly.error.error || syncEarly.error).includes("护理主管"));

  // 护士长核对护理动作（同步生成出所回访）
  const verify = await doAction(cookies["headnurse"], { action: "care.verify", planId, careNote: "冒烟核对：护理动作与费用一致" });
  check("护理主管核对护理动作并生成出所回访", verify.ok === true, JSON.stringify(verify));
  const headPage = await get("/headnurse", cookies["headnurse"]);
  check("护士长工作台含护理动作核对区", headPage.text.includes("护理动作核对"));

  // 家属同步前，家属端看不到方案
  const famBefore = await get("/family", cookies["smokefam"]);
  check("同步前家属端不显示退款方案", !famBefore.text.includes("提前退所退款方案（家属端同步）"));

  // 财务同步家属端
  const sync = await doAction(cookies["finance"], { action: "refund_plans.confirm", id: planId });
  check("退款方案同步家属端", sync.ok === true, JSON.stringify(sync));
  const famPage = await get("/family", cookies["smokefam"]);
  check("家属端显示退款方案明细与冻结提示", famPage.text.includes("提前退所退款方案") && famPage.text.includes("应退合计"));

  // 家属先提异议 → 护士长/财务处理 → 重新同步 → 家属知悉
  const dispute = await doAction(cookies["smokefam"], { action: "refund_plans.dispute", id: planId, note: "冒烟异议：餐食天数需复核" });
  check("家属对退款方案提出异议", dispute.ok === true);
  const reviewDuringDispute = await doAction(cookies["finance"], { action: "refund_plans.review", id: planId });
  check("异议未处理时财务复核被拦截", reviewDuringDispute.ok === false);
  const resolveDisp = await doAction(cookies["headnurse"], { action: "refund_plans.resolve_dispute", id: planId, note: "已复核餐食天数无误，向家属解释" });
  check("异议处理后退回重新同步", resolveDisp.ok === true);
  const sync2 = await doAction(cookies["finance"], { action: "refund_plans.confirm", id: planId });
  check("异议处理后重新同步家属", sync2.ok === true);
  const ack = await doAction(cookies["smokefam"], { action: "refund_plans.ack", id: planId, note: "已知悉，无异议" });
  check("家属知悉退款方案", ack.ok === true);

  // 财务复核退款 → 退款流水/已确认结算单/出所
  const reviewed = await doAction(cookies["finance"], { action: "refund_plans.review", id: planId, reviewNote: "冒烟复核无误" });
  check("财务复核退款并办理出所", reviewed.ok === true && String(reviewed.message).includes("退款"), JSON.stringify(reviewed));
  const famAfter = await get("/family", cookies["smokefam"]);
  check("家属端显示退款已复核", famAfter.text.includes("退款已财务复核"));
  const finPage = await get("/finance", cookies["finance"]);
  check("财务工作台结算单已确认且有提前退所退款流水", finPage.text.includes("提前退所退款"));

  // 清理：房间恢复空房，保证冒烟可重复运行
  await doAction(cookies["front"], { action: "rooms.update", id: smokeRoomId, status: "vacant" });
}

// 13b. 种子数据：901 房进行中的退款方案（财务已核对冻结，待护士长核对）——可重复运行，停在"已同步家属"以保留在住演示数据
{
  const fam2Login = await login("family2", "family123");
  check("901家属 family2 登录", fam2Login.ok === true);
  cookies["family2"] = fam2Login.cookie;
  let fam2 = await get("/family", cookies["family2"]);
  const alreadySynced = fam2.text.includes("提前退所退款方案");
  if (!alreadySynced) {
    const hp = await get("/headnurse", cookies["headnurse"]);
    check("护士长看到901待核对的提前退所方案", hp.text.includes("提前退所 · 护理动作核对"));
    const v = await doAction(cookies["headnurse"], { action: "care.verify", planId: 1, careNote: "护理动作与费用记录一致" });
    check("护士长核对种子退款方案#1", v.ok === true, JSON.stringify(v));
    const s = await doAction(cookies["finance"], { action: "refund_plans.confirm", id: 1 });
    check("财务同步种子方案#1至家属端", s.ok === true, JSON.stringify(s));
    fam2 = await get("/family", cookies["family2"]);
  }
  check("901家属端可见退款方案（应退11,311元）", fam2.text.includes("提前退所退款方案") && fam2.text.includes("11,311"));
  // 901 仍为在住订单（种子演示数据保留）
  const famStay = await get("/stays/2", cookies["admin"]);
  check("901核对同步后仍为在住（复核才出所）", famStay.status === 200 && famStay.text.includes("在住"));
}

// 14. 家属反馈 → 护士长回复并标记影响排班
{
  const fb = await doAction(cookies["family1"], { action: "feedbacks.create", stayId: 1, rating: 3, content: "冒烟测试反馈" });
  check("家属提交反馈", fb.ok === true);
  const rp = await doAction(cookies["headnurse"], { action: "feedbacks.respond", id: fb.id, response: "冒烟测试回复", affectScheduling: true });
  check("护士长回复反馈并标记影响排班", rp.ok === true);
}

// 15. 管理员看板能看到费用变化与异常
{
  const r = await get("/admin", cookies["admin"]);
  check("管理看板含高敏感客诉区", r.status === 200 && r.text.includes("高敏感客诉"));
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
