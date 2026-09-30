import { notFound } from "next/navigation";
import Link from "next/link";
import { q, q1, today } from "@/lib/db";
import { requireUser, can, STAFF_ROLES } from "@/lib/guard";
import { AppShell, Section, DataTable, KV, Badge } from "@/components/ui";
import { DataForm, ActionButton } from "@/components/client";
import { RefundPanel } from "@/components/refund";
import {
  PLAN_TYPES, EX_TYPES, EX_STATUS, SEVERITY, FEE_TYPES, TASK_STATUS, VISIT_STATUS,
  money, dt, badgeClass, severityClass,
} from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function StayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(STAFF_ROLES);
  const stayId = Number(id);
  const stay = q1(
    `SELECT s.*, r.number AS room_number, r.type AS room_type, p.name AS package_name, p.days AS package_days, p.price AS package_price
     FROM stays s JOIN rooms r ON r.id=s.room_id JOIN packages p ON p.id=s.package_id WHERE s.id=?`, stayId);
  if (!stay) notFound();
  const inStay = stay.status === "in_stay";
  const perms = JSON.parse(String(stay.visit_permissions || "{}"));

  const plans = q("SELECT p.*, u.name AS assignee FROM care_plans p LEFT JOIN users u ON u.id=p.assignee_id WHERE p.stay_id=? ORDER BY p.id", stayId);
  const tasks = q(`SELECT t.*, u.name AS assignee FROM care_tasks t LEFT JOIN users u ON u.id=t.assignee_id
                   WHERE t.stay_id=? ORDER BY t.scheduled_at DESC LIMIT 30`, stayId);
  const records = q("SELECT * FROM care_records WHERE stay_id=? ORDER BY created_at DESC LIMIT 30", stayId);
  const meals = q("SELECT * FROM meals WHERE stay_id=? ORDER BY meal_date DESC, id DESC LIMIT 15", stayId);
  const visits = q("SELECT * FROM visits WHERE stay_id=? ORDER BY visit_time DESC LIMIT 15", stayId);
  const hosting = q("SELECT * FROM hosting_logs WHERE stay_id=? ORDER BY start_time DESC LIMIT 15", stayId);
  const rounds = q("SELECT * FROM doctor_rounds WHERE stay_id=? ORDER BY round_date DESC LIMIT 10", stayId);
  const schedules = q(`SELECT ts.*, u.name AS therapist FROM therapist_schedules ts LEFT JOIN users u ON u.id=ts.therapist_id
                       WHERE ts.stay_id=? ORDER BY ts.scheduled_at DESC LIMIT 15`, stayId);
  const gifts = q("SELECT * FROM gifts WHERE stay_id=? ORDER BY id", stayId);
  const fees = q("SELECT * FROM fees WHERE stay_id=? ORDER BY created_at DESC", stayId);
  const settlement = q1("SELECT * FROM settlements WHERE stay_id=?", stayId);
  const refundPlan = q1("SELECT * FROM refund_plans WHERE stay_id=?", stayId);
  const refundEvents = refundPlan
    ? q("SELECT * FROM refund_plan_events WHERE refund_plan_id=? ORDER BY created_at", Number(refundPlan.id))
    : [];
  const exceptions = q("SELECT * FROM exceptions WHERE stay_id=? ORDER BY status='open' DESC, id DESC", stayId);
  const exEvents = q(`SELECT e.* FROM exception_events e JOIN exceptions x ON x.id=e.exception_id
                      WHERE x.stay_id=? ORDER BY e.created_at DESC LIMIT 30`, stayId);
  const messages = q("SELECT * FROM messages WHERE stay_id=? ORDER BY created_at DESC LIMIT 20", stayId);
  const feedbacks = q("SELECT * FROM feedbacks WHERE stay_id=? ORDER BY created_at DESC", stayId);
  const followUps = q("SELECT * FROM follow_ups WHERE stay_id=? ORDER BY scheduled_at", stayId);
  const referrals = q("SELECT * FROM referrals WHERE stay_id=? ORDER BY id DESC", stayId);
  const audits = q("SELECT * FROM audit_logs WHERE stay_id=? ORDER BY created_at DESC, id DESC LIMIT 40", stayId);
  const staffUsers = q("SELECT id,name,role FROM users WHERE active=1 AND role IN ('nurse','matron','therapist','nutritionist','pediatrician','head_nurse') ORDER BY role");
  const packages = q("SELECT * FROM packages ORDER BY price");

  const assigneeOptions = staffUsers.map((u) => ({ value: String(u.id), label: String(u.name) }));
  const todayStr = today();

  return (
    <AppShell title={`房间 ${stay.room_number} · ${stay.mother_name} ${inStay ? "（在住）" : "（已出所）"}`}>
      {/* 档案 */}
      <Section title="产妇与宝宝档案" extra={<Badge text={inStay ? "在住" : "已出所"} cls={badgeClass(String(stay.status))} />}>
        <KV items={[
          ["订单号", String(stay.code)],
          ["房间 / 套餐", `${stay.room_number}（${stay.room_type}）/ ${stay.package_name}`],
          ["入住 / 预计出所", `${stay.check_in_date} ~ ${stay.expected_checkout}${stay.actual_checkout ? `（实际 ${stay.actual_checkout}）` : ""}`],
          ["分娩方式", String(stay.delivery_method)],
          ["入住时产后天数", `${stay.postpartum_days} 天`],
          ["哺乳方式", String(stay.feeding_method)],
          ["过敏史", String(stay.allergy_history || "无")],
          ["餐食禁忌", <span key="t" className="badge amber">{String(stay.meal_taboos || "无")}</span>],
          ["医生建议", String(stay.doctor_advice || "-")],
          ["宝宝", `${stay.baby_name} · ${stay.baby_weight}kg`],
          ["黄疸观察", <span key="j">{String(stay.jaundice_level)}mg/dL <span className="muted small">{String(stay.jaundice_note || "")}</span></span>],
          ["家属探访权限", (perms.visitors || []).join("、") || "-"],
        ]} />
      </Section>

      {/* 异常工单 */}
      <Section title="异常工单（围绕本房处理）" tone={exceptions.some((e) => e.status === "open") ? "tone-red" : ""}
        extra={<Badge text={`${exceptions.filter((e) => e.status === "open" || e.status === "processing").length} 件待办`} cls="badge red" />}>
        <DataTable
          cols={["类型", "标题", "严重度", "状态", "责任角色", "同步护士长", "处理"]}
          empty="暂无异常"
          rows={exceptions.map((e) => [
            <span key="t">{EX_TYPES[String(e.type)] || String(e.type)}</span>,
            <span key="ti">{String(e.title)}<div className="muted small">{String(e.description)}</div></span>,
            <Badge key="s" text={SEVERITY[String(e.severity)] || String(e.severity)} cls={severityClass(String(e.severity))} />,
            <Badge key="st" text={EX_STATUS[String(e.status)] || String(e.status)} cls={badgeClass(String(e.status))} />,
            String(e.assigned_role || "-"),
            Number(e.synced_head_nurse) ? "已同步" : "-",
            can(user, ["admin", "head_nurse", "nurse", "pediatrician", "nutritionist", "therapist", "frontdesk", "finance"]) && e.status !== "resolved" && e.status !== "closed" ? (
              <DataForm key="f" compact action="exceptions.update" hidden={{ id: Number(e.id) }}
                fields={[
                  { name: "op", label: "操作", type: "select", required: true, options: [
                    { value: "accept", label: "受理" }, { value: "note", label: "追加记录" },
                    { value: "resolve", label: "解决" }, { value: "close", label: "关闭" } ] },
                  { name: "note", label: "处理说明", placeholder: "处理过程 / 解决方案" },
                ]}
                submitLabel="提交" />
            ) : <span key="d" className="muted small">{String(e.resolution || "-")}</span>,
          ])}
        />
        {exEvents.length > 0 && (
          <div className="mt8">
            <div className="muted small">处置时间线：</div>
            <ul className="timeline">
              {exEvents.slice(0, 8).map((ev) => (
                <li key={String(ev.id)}>
                  <span className="t-time">{dt(ev.created_at)}</span>
                  <b>{String(ev.user_name)}</b> {String(ev.action)}：{String(ev.note)}
                </li>
              ))}
            </ul>
          </div>
        )}
        <details className="mt8">
          <summary className="muted">上报新异常</summary>
          <DataForm action="exceptions.create" hidden={{ stayId }}
            fields={[
              { name: "type", label: "异常类型", type: "select", required: true, options: Object.entries(EX_TYPES).map(([v, l]) => ({ value: v, label: l })) },
              { name: "title", label: "标题", required: true },
              { name: "description", label: "详细描述", type: "textarea" },
              { name: "severity", label: "严重度", type: "select", required: true, options: Object.entries(SEVERITY).map(([v, l]) => ({ value: v, label: l })) },
            ]}
            submitLabel="上报异常" />
        </details>
      </Section>

      <div className="grid cols-2">
        {/* 护理计划与任务 */}
        <Section title="护理计划与任务"
          extra={can(user, ["head_nurse", "nurse", "admin"]) ? (
            <ActionButton action="tasks.generate" payload={{ stayId, date: todayStr }} label="生成今日任务" />
          ) : undefined}>
          <DataTable cols={["计划", "类型", "频次", "负责人"]} empty="暂无计划"
            rows={plans.map((p) => [String(p.title), PLAN_TYPES[String(p.type)] || String(p.type), String(p.frequency), String(p.assignee || "未分配")])} />
          <div className="mt8 muted small">最近任务：</div>
          <DataTable cols={["时间", "任务", "负责人", "状态", "执行"]} empty="暂无任务"
            rows={tasks.map((t) => [
              <span key="a" className="small">{dt(t.scheduled_at)}</span>,
              <span key="b">{String(t.title)}{Number(t.visible_to_family) ? "" : <span className="badge gray">内部</span>}
                {t.record ? <div className="muted small">{String(t.record)}</div> : null}</span>,
              String(t.assignee || "未分配"),
              <Badge key="c" text={TASK_STATUS[String(t.status)] || String(t.status)} cls={badgeClass(String(t.status))} />,
              t.status === "pending" && can(user, ["nurse", "matron", "head_nurse", "admin", "nutritionist", "therapist"]) ? (
                <DataForm key="f" compact action="tasks.update" hidden={{ id: Number(t.id), status: "done" }}
                  fields={[{ name: "record", label: "执行记录", placeholder: "填写护理记录", required: true }]} submitLabel="完成" />
              ) : <span key="x" className="muted small">{t.done_at ? dt(t.done_at) : "-"}</span>,
            ])} />
          {can(user, ["head_nurse", "nurse", "admin"]) && (
            <details className="mt8">
              <summary className="muted">安排新任务 / 新计划</summary>
              <DataForm action="tasks.create" hidden={{ stayId }}
                fields={[
                  { name: "type", label: "类型", type: "select", required: true, options: Object.entries(PLAN_TYPES).map(([v, l]) => ({ value: v, label: l })) },
                  { name: "title", label: "任务名称", required: true },
                  { name: "scheduledAt", label: "计划时间", type: "datetime-local", required: true },
                  { name: "assigneeId", label: "负责人", type: "select", options: assigneeOptions },
                ]} submitLabel="添加任务" />
              {can(user, ["head_nurse", "admin"]) && (
                <div className="mt8">
                  <DataForm action="plans.create" hidden={{ stayId }}
                    fields={[
                      { name: "type", label: "类型", type: "select", required: true, options: Object.entries(PLAN_TYPES).map(([v, l]) => ({ value: v, label: l })) },
                      { name: "title", label: "计划名称", required: true },
                      { name: "frequency", label: "频次", placeholder: "如 每日1次" },
                      { name: "assigneeId", label: "负责人", type: "select", options: assigneeOptions },
                    ]} submitLabel="添加护理计划" />
                </div>
              )}
            </details>
          )}
        </Section>

        {/* 护理记录 */}
        <Section title="护理记录（进入出所后母婴随访）">
          <DataTable cols={["时间", "记录人", "内容", "家属可见", "状态"]} empty="暂无记录"
            rows={records.map((r) => [
              <span key="a" className="small">{dt(r.created_at)}</span>,
              String(r.created_by_name),
              <span key="b">{String(r.content)}</span>,
              Number(r.visible_to_family) ? "是" : "否",
              Number(r.disputed) ? <Badge key="d" text="家属质疑中" cls="badge red" /> : <span key="n" className="muted small">正常</span>,
            ])} />
          {can(user, ["nurse", "matron", "head_nurse", "admin", "pediatrician"]) && (
            <details className="mt8">
              <summary className="muted">新增护理记录</summary>
              <DataForm action="records.create" hidden={{ stayId }}
                fields={[
                  { name: "type", label: "类型", type: "select", required: true, options: Object.entries(PLAN_TYPES).map(([v, l]) => ({ value: v, label: l })) },
                  { name: "content", label: "记录内容", type: "textarea", required: true },
                  { name: "visibleToFamily", label: "家属可见", type: "checkbox", defaultValue: true },
                ]} submitLabel="保存记录" />
            </details>
          )}
        </Section>
      </div>

      <div className="grid cols-2">
        {/* 月子餐 */}
        <Section title="月子餐与忌口核对">
          <DataTable cols={["日期", "餐次", "菜单", "忌口核对", "状态"]} empty="暂无配餐"
            rows={meals.map((m) => [
              String(m.meal_date), String(m.meal_type), String(m.menu),
              m.taboo_hits ? <span key="h" className="badge red">命中：{String(m.taboo_hits)}</span> : <span key="ok" className="badge green">通过</span>,
              <Badge key="s" text={String(m.status) === "issue" ? "有问题" : String(m.status) === "confirmed" ? "已确认" : "已计划"} cls={badgeClass(String(m.status))} />,
            ])} />
          {can(user, ["nutritionist", "admin"]) && (
            <details className="mt8">
              <summary className="muted">登记配餐（自动忌口核对）</summary>
              <DataForm action="meals.create" hidden={{ stayId }}
                fields={[
                  { name: "mealDate", label: "日期", type: "date", required: true, defaultValue: todayStr },
                  { name: "mealType", label: "餐次", type: "select", required: true, options: ["早餐", "午餐", "晚餐", "加餐"].map((v) => ({ value: v, label: v })) },
                  { name: "menu", label: "菜单", type: "textarea", required: true, placeholder: "如：山药排骨汤、清蒸鲈鱼、时蔬" },
                ]} submitLabel="登记并核对忌口" />
            </details>
          )}
        </Section>

        {/* 探访管理 */}
        <Section title="家属探访（含消毒登记）">
          <DataTable cols={["探访人", "时间", "时长", "状态", "消毒", "操作"]} empty="暂无探访"
            rows={visits.map((v) => [
              <span key="a">{String(v.visitor_name)}<span className="muted small">（{String(v.relation)}）</span>{Number(v.is_temp) ? <span className="badge amber">临时</span> : null}</span>,
              <span key="b" className="small">{dt(v.visit_time)}</span>,
              `${v.hours}小时`,
              <Badge key="c" text={VISIT_STATUS[String(v.status)] || String(v.status)} cls={badgeClass(String(v.status))} />,
              Number(v.disinfected) ? <span key="d" className="badge green">已消毒</span> : <span key="d2" className="badge gray">未登记</span>,
              can(user, ["frontdesk", "head_nurse", "admin"]) ? (
                <span key="ops" className="row">
                  {v.status === "pending" && <>
                    <ActionButton action="visits.update" payload={{ id: Number(v.id), op: "approve" }} label="批准" kind="primary" />
                    <ActionButton action="visits.update" payload={{ id: Number(v.id), op: "reject" }} label="拒绝" kind="danger" />
                  </>}
                  {v.status === "approved" && !Number(v.disinfected) &&
                    <ActionButton action="visits.update" payload={{ id: Number(v.id), op: "disinfect" }} label="消毒登记" />}
                  {v.status === "approved" &&
                    <ActionButton action="visits.update" payload={{ id: Number(v.id), op: "complete" }} label="完成探访" />}
                </span>
              ) : <span key="x" className="muted small">-</span>,
            ])} />
        </Section>
      </div>

      <div className="grid cols-2">
        {/* 宝宝托管 */}
        <Section title="宝宝托管日志">
          <DataTable cols={["类型", "开始", "结束", "照护人", "备注"]} empty="暂无托管记录"
            rows={hosting.map((h) => [
              String(h.type), <span key="a" className="small">{dt(h.start_time)}</span>,
              <span key="b" className="small">{h.end_time ? dt(h.end_time) : "进行中"}</span>,
              String(h.caregiver_name), String(h.notes || "-"),
            ])} />
          {can(user, ["nurse", "matron", "head_nurse", "admin"]) && (
            <details className="mt8">
              <summary className="muted">登记托管日志</summary>
              <DataForm action="hosting.create" hidden={{ stayId }}
                fields={[
                  { name: "type", label: "类型", type: "select", options: ["托管", "夜间托管", "洗澡抚触"].map((v) => ({ value: v, label: v })) },
                  { name: "startTime", label: "开始时间", type: "datetime-local", required: true },
                  { name: "endTime", label: "结束时间", type: "datetime-local" },
                  { name: "notes", label: "备注", placeholder: "吃奶、睡眠、排便等情况" },
                ]} submitLabel="登记" />
            </details>
          )}
        </Section>

        {/* 医生巡诊 */}
        <Section title="医生巡诊记录">
          <DataTable cols={["日期", "医生", "查体发现", "建议"]} empty="暂无巡诊记录"
            rows={rounds.map((r) => [String(r.round_date), String(r.doctor_name), String(r.findings), String(r.advice)])} />
          {can(user, ["pediatrician", "admin"]) && (
            <details className="mt8">
              <summary className="muted">新增巡诊记录</summary>
              <DataForm action="rounds.create" hidden={{ stayId }}
                fields={[
                  { name: "roundDate", label: "巡诊日期", type: "date", required: true, defaultValue: todayStr },
                  { name: "findings", label: "查体发现", type: "textarea", required: true },
                  { name: "advice", label: "医生建议", type: "textarea" },
                  { name: "jaundiceLevel", label: "黄疸复测值(mg/dL，留空不更新)", type: "number", step: "0.1" },
                ]} submitLabel="保存巡诊" />
            </details>
          )}
        </Section>
      </div>

      <div className="grid cols-2">
        {/* 产康排班 */}
        <Section title="产康师排班">
          <DataTable cols={["项目", "时间", "产康师", "状态", "操作"]} empty="暂无排班"
            rows={schedules.map((s) => [
              String(s.project), <span key="a" className="small">{dt(s.scheduled_at)}</span>, String(s.therapist || "-"),
              <Badge key="b" text={{ scheduled: "已排班", done: "已完成", delayed: "已延期", cancelled: "已取消" }[String(s.status)] || String(s.status)} cls={badgeClass(String(s.status))} />,
              s.status === "scheduled" && can(user, ["therapist", "head_nurse", "admin"]) ? (
                <span key="ops" className="row">
                  <ActionButton action="schedules.update" payload={{ id: Number(s.id), op: "done" }} label="完成" />
                  <DataForm compact action="schedules.update" hidden={{ id: Number(s.id), op: "delay" }}
                    fields={[
                      { name: "reason", label: "延期原因", required: true },
                      { name: "newTime", label: "改期至", type: "datetime-local", required: true },
                    ]} submitLabel="延期" />
                </span>
              ) : <span key="x" className="muted small">{String(s.delay_reason || "-")}</span>,
            ])} />
          {can(user, ["therapist", "head_nurse", "admin"]) && (
            <details className="mt8">
              <summary className="muted">新增产康排班</summary>
              <DataForm action="schedules.create" hidden={{ stayId }}
                fields={[
                  { name: "project", label: "项目", required: true, placeholder: "如 盆底肌修复（第4节）" },
                  { name: "scheduledAt", label: "时间", type: "datetime-local", required: true },
                  { name: "therapistId", label: "产康师", type: "select", options: staffUsers.filter((u) => u.role === "therapist").map((u) => ({ value: String(u.id), label: String(u.name) })) },
                ]} submitLabel="排班" />
            </details>
          )}
        </Section>

        {/* 赠品 */}
        <Section title="套餐赠品">
          <DataTable cols={["赠品", "来源", "状态", "操作"]} empty="暂无赠品"
            rows={gifts.map((g) => [
              String(g.name),
              g.source === "package" ? "套餐内含" : "额外赠送",
              g.status === "delivered"
                ? <span key="d" className="badge green">已发放 {dt(g.delivered_at)}</span>
                : <span key="p" className="badge amber">待发放</span>,
              g.status !== "delivered" && can(user, ["frontdesk", "admin"])
                ? <ActionButton key="b" action="gifts.deliver" payload={{ id: Number(g.id) }} label="发放" kind="primary" />
                : <span key="x" className="muted small">-</span>,
            ])} />
          {can(user, ["frontdesk", "admin"]) && (
            <details className="mt8">
              <summary className="muted">追加赠品</summary>
              <DataForm action="gifts.create" hidden={{ stayId }}
                fields={[{ name: "name", label: "赠品名称", required: true }]} submitLabel="添加" />
            </details>
          )}
        </Section>
      </div>

      {/* 套餐提前退所退款方案 */}
      {refundPlan && (
        <RefundPanel plan={refundPlan} user={user} events={refundEvents}
          roomNumber={String(stay.room_number)} />
      )}

      {/* 费用与结算 */}
      <Section title="费用明细与结算"
        extra={can(user, ["finance", "admin"]) ? (
          <span className="row">
            <DataForm compact action="fees.create" hidden={{ stayId }}
              fields={[
                { name: "type", label: "类型", type: "select", required: true, options: Object.entries(FEE_TYPES).map(([v, l]) => ({ value: v, label: l })) },
                { name: "direction", label: "方向", type: "select", required: true, options: [{ value: "charge", label: "应收" }, { value: "refund", label: "退款" }] },
                { name: "amount", label: "金额", type: "number", required: true },
                { name: "description", label: "说明", required: true },
              ]} submitLabel="登记费用" />
          </span>
        ) : undefined}>
        <DataTable cols={["时间", "类型", "说明", "方向", "金额", "状态"]} empty="暂无费用"
          rows={fees.map((f) => [
            <span key="a" className="small">{dt(f.created_at)}</span>,
            FEE_TYPES[String(f.type)] || String(f.type),
            String(f.description),
            f.direction === "refund" ? <span key="r" className="badge blue">退款</span> : <span key="c" className="badge gray">应收</span>,
            <b key="m">{money(f.amount)}</b>,
            <Badge key="s" text={f.status === "void" ? "已作废" : "已确认"} cls={badgeClass(String(f.status))} />,
          ])} />
        {settlement ? (
          <div className="mt8">
            <KV items={[
              ["应收合计", money(settlement.total_charge)],
              ["退款合计", money(settlement.total_refund)],
              ["实收", money(settlement.paid)],
              ["余额", Number(settlement.balance) < 0
                ? <b key="b" className="badge blue">平台应退 {money(-Number(settlement.balance))}</b>
                : <b key="b">{money(settlement.balance)}</b>],
              ["状态", <Badge key="s" text={settlement.status === "confirmed" ? "已确认" : "待确认"} cls={badgeClass(String(settlement.status))} />],
              ["说明", String(settlement.detail || "-")],
            ]} />
            {settlement.status !== "confirmed" && can(user, ["finance", "admin"]) && (
              <div className="mt8">
                <ActionButton action="settlements.confirm" payload={{ stayId }} label="确认结算（实收=应收-退款）" kind="primary"
                  confirm="确认该订单结算无误？" />
              </div>
            )}
          </div>
        ) : <div className="muted small mt8">尚未生成结算单（办理出所时自动生成）。</div>}
        {inStay && can(user, ["frontdesk", "finance", "admin"]) && (
          <div className="mt16 row">
            {!refundPlan ? (
              <DataForm compact action="stays.checkout" hidden={{ stayId }}
                fields={[
                  { name: "checkoutDate", label: "实际退所日期", type: "date", required: true, defaultValue: todayStr },
                  { name: "reason", label: "退所原因（提前退所必填，如家庭原因）" },
                ]}
                submitLabel="办理出所 / 申请提前退所" />
            ) : (
              <span className="badge amber">提前退所结算进行中，请在上方退款方案中完成核对/冻结/复核</span>
            )}
            {can(user, ["frontdesk", "admin"]) && (
              <DataForm compact action="stays.upgrade" hidden={{ stayId }}
                fields={[{ name: "newPackageId", label: "升级至套餐", type: "select", required: true, options: packages.map((p) => ({ value: String(p.id), label: `${p.name}（${money(p.price)}）` })) }]}
                submitLabel="套餐升级" />
            )}
          </div>
        )}
      </Section>

      <div className="grid cols-2">
        {/* 家属沟通 */}
        <Section title="家属沟通记录">
          <ul className="timeline">
            {messages.length === 0 && <li>暂无沟通记录</li>}
            {messages.map((m) => (
              <li key={String(m.id)}>
                <span className="t-time">{dt(m.created_at)}</span>
                <b>{String(m.from_name)}</b>
                <span className="muted small">（{m.from_role === "family" ? "家属" : "员工"}→{m.audience === "staff" ? "中心" : m.audience === "family" ? "家属" : "双方"}）</span>
                ：{String(m.content)}
              </li>
            ))}
          </ul>
          <div className="mt8">
            <DataForm compact action="messages.create" hidden={{ stayId }}
              fields={[
                { name: "audience", label: "可见范围", type: "select", options: [{ value: "all", label: "员工与家属" }, { value: "family", label: "仅家属" }, { value: "staff", label: "仅员工" }] },
                { name: "content", label: "内容", type: "textarea", required: true },
              ]} submitLabel="发送" />
          </div>
        </Section>

        {/* 家属反馈 */}
        <Section title="家属反馈（影响排班与口碑）">
          <DataTable cols={["时间", "评分", "内容", "回复", "影响排班"]} empty="暂无反馈"
            rows={feedbacks.map((f) => [
              <span key="a" className="small">{dt(f.created_at)}</span>,
              <span key="r" className={Number(f.rating) <= 2 ? "badge red" : "badge green"}>{"★".repeat(Number(f.rating))}</span>,
              <span key="c">{String(f.content)}</span>,
              f.response ? String(f.response) : (can(user, ["head_nurse", "admin"]) ? (
                <DataForm key="rf" compact action="feedbacks.respond" hidden={{ id: Number(f.id) }}
                  fields={[
                    { name: "response", label: "回复", required: true },
                    { name: "affectScheduling", label: "影响护理师排班", type: "checkbox" },
                  ]} submitLabel="回复" />
              ) : <span className="muted small">待回复</span>),
              Number(f.affect_scheduling) ? <span key="af" className="badge amber">已纳入排班参考</span> : "-",
            ])} />
        </Section>
      </div>

      <div className="grid cols-2">
        {/* 随访 */}
        <Section title="出所后回访 / 母婴随访">
          <DataTable cols={["类型", "计划时间", "内容", "状态", "结果"]} empty="暂无随访计划"
            rows={followUps.map((f) => [
              String(f.type), dt(f.scheduled_at), String(f.content),
              <Badge key="s" text={f.status === "done" ? "已完成" : "待执行"} cls={badgeClass(String(f.status))} />,
              f.status === "done" ? String(f.result) : (can(user, ["head_nurse", "admin", "frontdesk"]) ? (
                <DataForm key="ff" compact action="followups.done" hidden={{ id: Number(f.id) }}
                  fields={[{ name: "result", label: "随访结果", required: true }]} submitLabel="完成" />
              ) : "-"),
            ])} />
          {can(user, ["head_nurse", "admin", "frontdesk"]) && (
            <details className="mt8">
              <summary className="muted">安排随访</summary>
              <DataForm action="followups.create" hidden={{ stayId }}
                fields={[
                  { name: "type", label: "类型", type: "select", options: [{ value: "回访", label: "回访" }, { value: "母婴随访", label: "母婴随访" }] },
                  { name: "scheduledAt", label: "时间", type: "datetime-local", required: true },
                  { name: "content", label: "内容" },
                ]} submitLabel="安排" />
            </details>
          )}
        </Section>

        {/* 复购转介绍 */}
        <Section title="复购 / 转介绍线索">
          <DataTable cols={["类型", "线索", "电话", "备注", "状态"]} empty="暂无线索"
            rows={referrals.map((r) => [
              r.kind === "repurchase" ? "复购" : "转介绍",
              String(r.lead_name), String(r.lead_phone || "-"), String(r.note || "-"),
              <Badge key="s" text={{ new: "新线索", following: "跟进中", converted: "已成交", lost: "已流失" }[String(r.status)] || String(r.status)} cls={badgeClass(String(r.status))} />,
            ])} />
          {can(user, ["frontdesk", "admin", "head_nurse"]) && (
            <details className="mt8">
              <summary className="muted">登记线索</summary>
              <DataForm action="referrals.create" hidden={{ stayId }}
                fields={[
                  { name: "kind", label: "类型", type: "select", options: [{ value: "referral", label: "转介绍" }, { value: "repurchase", label: "复购" }] },
                  { name: "leadName", label: "姓名", required: true },
                  { name: "leadPhone", label: "电话" },
                  { name: "note", label: "备注" },
                ]} submitLabel="登记" />
            </details>
          )}
        </Section>
      </div>

      {/* 房间动态 */}
      <Section title="房间动态时间线（护理动作 / 家属沟通 / 费用变化 / 异常处置）">
        <ul className="timeline">
          {audits.map((a) => (
            <li key={String(a.id)}>
              <span className="t-time">{dt(a.created_at)}</span>
              <span className="badge blue">{String(a.action)}</span> <b>{String(a.actor_name)}</b>：{String(a.detail)}
            </li>
          ))}
        </ul>
      </Section>

      <div className="muted small"><Link href="/">← 返回工作台</Link></div>
    </AppShell>
  );
}
