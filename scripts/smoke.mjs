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

// 12+13. 前台登记新入住 → 套餐提前退所全流程（申请→平台核对→生成方案→冻结套餐尾款→护理核对→同步家属→财务复核→出所）
let smokeStayId = null;
let smokeRoomId = null;
let smokeCookie = null;
// 每次运行使用唯一家属账号，避免重复运行产生多订单关联
const smokeFamUser = `smokefam${Date.now().toString().slice(-6)}`;
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
      familyUsername: smokeFamUser, familyPassword: "smoke123", familyName: "冒烟家属", familyRelation: "丈夫",
    });
    check("前台入住登记", r.ok === true, JSON.stringify(r));
    if (r.ok) {
      smokeStayId = r.id;
      const fam = await login(smokeFamUser, "smoke123");
      check("新家属账号可登录", fam.ok === true);
      smokeCookie = fam.cookie;
      const page = await get("/family", fam.cookie);
      check("新家属端显示入住信息", page.status === 200 && page.text.includes("冒烟测试产妇"));
    }
  }
}

if (smokeStayId) {
  // 财务先登记一笔增项费用，纳入平台核对
  const fee = await doAction(cookies["finance"], { action: "fees.create", stayId: smokeStayId, type: "extra", direction: "charge", amount: 100, description: "冒烟测试增项" });
  check("财务登记增项费用", fee.ok === true);

  // 13.1 前台/财务提交提前退所申请（平台核对：已住天数/产康/餐食/赠品/押金）
  const apply = await doAction(cookies["front"], { action: "stays.checkout", stayId: smokeStayId, checkoutDate: "2026-09-30", reason: "家庭原因需提前返乡" });
  check("提交提前退所申请并完成平台核对", apply.ok === true && !!apply.planId, JSON.stringify(apply));
  const dup = await doAction(cookies["front"], { action: "stays.checkout", stayId: smokeStayId, checkoutDate: "2026-09-30", reason: "重复申请" });
  check("重复提前退所申请被拒绝", dup.ok === false);
  const noReason = await doAction(cookies["finance"], { action: "stays.create", roomId: 999, packageId: 1, motherName: "x", checkInDate: "2026-09-30" });
  check("不存在房间入住被拒绝", noReason.ok === false);

  // 13.2 尾款未冻结前，护士长不能核对护理动作
  const careEarly = await doAction(cookies["headnurse"], { action: "refunds.careConfirm", stayId: smokeStayId, note: "提前核对" });
  check("尾款冻结前护理核对被拦截", careEarly.ok === false);

  // 13.3 财务生成退款方案并冻结套餐尾款
  const gen = await doAction(cookies["finance"], { action: "refunds.generate", stayId: smokeStayId, adjustment: 0 });
  check("财务生成退款方案", gen.ok === true && /应退/.test(gen.message || ""), JSON.stringify(gen));
  const fz = await doAction(cookies["finance"], { action: "refunds.freeze", stayId: smokeStayId });
  check("财务冻结套餐尾款", fz.ok === true, JSON.stringify(fz));

  // 13.4 冻结后结算单不可确认；护理未核对前不能同步家属/复核
  const confirmFrozen = await doAction(cookies["finance"], { action: "settlements.confirm", stayId: smokeStayId });
  check("尾款冻结期间结算确认被拦截", confirmFrozen.ok === false);
  const syncEarly = await doAction(cookies["finance"], { action: "refunds.syncFamily", stayId: smokeStayId });
  check("护理核对前同步家属被拦截", syncEarly.ok === false);
  const reviewEarly = await doAction(cookies["finance"], { action: "refunds.review", stayId: smokeStayId, op: "approve" });
  check("护理核对前财务复核被拦截", reviewEarly.ok === false);

  // 13.5 家属端在同步前看不到退款方案
  const famBefore = await get("/family", smokeCookie);
  check("同步前家属端不可见退款方案", famBefore.status === 200 && !famBefore.text.includes("套餐提前退所退款方案"));

  // 13.6 护士长核对已完成护理动作（费用与服务记录一致）
  const care = await doAction(cookies["headnurse"], { action: "refunds.careConfirm", stayId: smokeStayId, note: "冒烟核对：护理动作与记录一致" });
  check("护士长核对护理动作", care.ok === true, JSON.stringify(care));

  // 13.7 未同步家属仍不能复核
  const reviewBeforeSync = await doAction(cookies["finance"], { action: "refunds.review", stayId: smokeStayId, op: "approve" });
  check("同步家属前财务复核被拦截", reviewBeforeSync.ok === false);

  // 13.8 退款方案同步家属端，家属可见
  const sync = await doAction(cookies["finance"], { action: "refunds.syncFamily", stayId: smokeStayId });
  check("退款方案同步家属端", sync.ok === true, JSON.stringify(sync));
  const famAfter = await get("/family", smokeCookie);
  check("同步后家属端可见退款方案与应退金额", famAfter.status === 200 && famAfter.text.includes("套餐提前退所退款方案") && famAfter.text.includes("应退合计"));

  // 13.9 财务复核通过 → 生成退款、确认结算、正式出所
  const rv = await doAction(cookies["finance"], { action: "refunds.review", stayId: smokeStayId, op: "approve", note: "复核无误" });
  check("财务复核退款并办理出所", rv.ok === true && /复核通过/.test(rv.message || ""), JSON.stringify(rv));

  // 13.10 复核后：结算已确认、退款流水已生成、出所回访已生成
  const finPage = await get("/finance", cookies["finance"]);
  check("财务页含已完成提前退所退款", finPage.status === 200 && finPage.text.includes("已完成提前退所退款"));
  const stayPage = await get(`/stays/${smokeStayId}`, cookies["admin"]);
  check("房间视图含退款记录与出所回访", stayPage.status === 200 && stayPage.text.includes("提前退所出所回访"));
  const coAgain = await doAction(cookies["finance"], { action: "stays.checkout", stayId: smokeStayId, checkoutDate: "2026-09-30", reason: "x" });
  check("已出所订单不能重复办理", coAgain.ok === false);

  // 清理：房间恢复空房，保证冒烟可重复运行
  await doAction(cookies["front"], { action: "rooms.update", id: smokeRoomId, status: "vacant" });
}

// 13b. 正常到期出所：直接生成结算草稿 → 财务确认（不走退款流程）
{
  const roomsRes = await fetch(`${BASE}/api/rooms`, { headers: { Cookie: cookies["front"] } });
  const vacant = ((await roomsRes.json()).rooms || []).find((r) => r.status === "vacant");
  if (vacant) {
    const cr = await doAction(cookies["front"], {
      action: "stays.create", roomId: vacant.id, packageId: 1, motherName: "正常出所产妇",
      checkInDate: "2026-09-01", postpartumDays: 28, feedingMethod: "母乳喂养", deposit: 3000,
    });
    if (cr.ok) {
      const normalId = cr.id;
      // 应出所 = 2026-09-01 + 28 = 2026-09-29；09-30 办理非提前
      const co = await doAction(cookies["finance"], { action: "stays.checkout", stayId: normalId, checkoutDate: "2026-09-30", reason: "到期正常出所" });
      check("正常到期出所直接生成结算草稿", co.ok === true, JSON.stringify(co));
      const cf = await doAction(cookies["finance"], { action: "settlements.confirm", stayId: normalId });
      check("正常出所结算确认成功", cf.ok === true, JSON.stringify(cf));
      await doAction(cookies["front"], { action: "rooms.update", id: vacant.id, status: "vacant" });
    }
  }
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
