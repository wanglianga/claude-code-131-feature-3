import Link from "next/link";
import { q, q1 } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, Badge } from "@/components/ui";
import { DataForm } from "@/components/client";
import { EX_TYPES, EX_STATUS, SEVERITY, REFUND_PLAN_STATUS, money, dt, badgeClass, severityClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function HeadNursePage() {
  await requireUser(["head_nurse", "admin"]);
  const exceptions = q(
    `SELECT e.*, r.number, s.mother_name FROM exceptions e
     JOIN stays s ON s.id=e.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE e.status IN ('open','processing') ORDER BY
       CASE e.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, e.created_at DESC`);
  const disputes = q(
    `SELECT e.*, r.number, s.mother_name FROM exceptions e
     JOIN stays s ON s.id=e.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE e.synced_head_nurse=1 ORDER BY e.status='open' DESC, e.created_at DESC LIMIT 10`);
  const feedbacks = q(
    `SELECT f.*, r.number, s.mother_name FROM feedbacks f
     JOIN stays s ON s.id=f.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY f.status='new' DESC, f.created_at DESC LIMIT 10`);
  const leaves = q(
    `SELECT e.*, r.number FROM exceptions e JOIN stays s ON s.id=e.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE e.type='matron_leave' AND e.status IN ('open','processing')`);
  const matrons = q("SELECT id,name FROM users WHERE active=1 AND role IN ('matron','nurse')");
  const inStays = q(
    `SELECT s.id, r.number, s.mother_name FROM stays s JOIN rooms r ON r.id=s.room_id
     WHERE s.status='in_stay' ORDER BY r.number`);
  const followUps = q(
    `SELECT f.*, r.number, s.mother_name FROM follow_ups f
     JOIN stays s ON s.id=f.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE f.status='pending' ORDER BY f.scheduled_at LIMIT 10`);
  // 提前退所：待护理主管核对护理动作的退款方案（冻结中）/ 家属异议方案
  const refundPlans = q(
    `SELECT rp.*, r.number, s.mother_name FROM refund_plans rp
     JOIN stays s ON s.id=rp.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE rp.status IN ('frozen','disputed') ORDER BY rp.updated_at DESC`);
  const plansWithStats = refundPlans.map((p) => {
    const stayId = Number(p.stay_id);
    return {
      p,
      taskDone: Number(q1("SELECT COUNT(*) AS c FROM care_tasks WHERE stay_id=? AND status='done'", stayId)?.c || 0),
      taskPending: Number(q1("SELECT COUNT(*) AS c FROM care_tasks WHERE stay_id=? AND status='pending'", stayId)?.c || 0),
      records: Number(q1("SELECT COUNT(*) AS c FROM care_records WHERE stay_id=?", stayId)?.c || 0),
      undisp: Number(q1("SELECT COUNT(*) AS c FROM care_records WHERE stay_id=? AND disputed=1", stayId)?.c || 0),
    };
  });
  const checkoutFollowUps = q(
    `SELECT f.*, r.number, s.mother_name FROM follow_ups f
     JOIN stays s ON s.id=f.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE f.type='出所回访' AND f.status='pending' ORDER BY f.scheduled_at`);

  return (
    <AppShell title="护士长工作台">
      <div className="grid cols-4">
        <div className="stat"><div className="num">{exceptions.length}</div><div className="label">待处理异常工单</div></div>
        <div className="stat"><div className="num">{disputes.filter((d) => d.status === "open").length}</div><div className="label">同步我的争议/质疑</div></div>
        <div className="stat"><div className="num">{refundPlans.filter((x) => x.status === "frozen").length}</div><div className="label">提前退所待核对护理</div></div>
        <div className="stat"><div className="num">{leaves.length}</div><div className="label">月嫂请假待协调</div></div>
      </div>

      <Section title="提前退所 · 护理动作核对（确认已完成护理动作，避免费用和服务记录脱节）"
        tone={refundPlans.some((x) => x.status === "frozen") ? "tone-red" : ""}>
        <DataTable cols={["房间", "方案", "护理任务（已完成/待执行）", "护理记录（含质疑）", "产康/餐食（财务核对）", "应退", "状态", "护理核对"]}
          empty="暂无待核对的提前退所方案"
          rows={plansWithStats.map(({ p, taskDone, taskPending, records, undisp }) => [
            <Link key="r" href={`/stays/${p.stay_id}`}>{String(p.number)} {String(p.mother_name)}</Link>,
            <span key="pl" className="small">#{String(p.id)} 拟{String(p.checkout_date)}退所<div className="muted">{String(p.reason)}</div></span>,
            <span key="t"><b className={taskPending ? "" : ""}>{taskDone}</b> / {taskPending}{taskPending > 0 && <span className="badge amber">有待执行</span>}</span>,
            <span key="rc">{records} 条{undisp > 0 ? <span className="badge red">质疑{undisp}</span> : <span className="badge green">无未结质疑</span>}</span>,
            <span key="s" className="small">已执行产康 {String(p.recovery_done_count)} 次（{money(p.recovery_cost)}）<br />已供餐 {String(p.meal_days)} 天（{money(p.meal_cost)}）</span>,
            <b key="m">{money(p.total_refund)}</b>,
            <span key="st">
              <Badge text={REFUND_PLAN_STATUS[String(p.status)] || String(p.status)} cls={p.status === "disputed" ? "badge red" : "badge amber"} />
              {Number(p.care_verified) === 1 && <div className="badge green">已核对 {dt(p.care_verified_at)}</div>}
            </span>,
            p.status === "frozen" && Number(p.care_verified) === 0 ? (
              <DataForm key="f" compact action="care.verify" hidden={{ planId: Number(p.id) }}
                fields={[{ name: "careNote", label: "核对说明（可选）", placeholder: "确认已完成护理动作/待执行项处理方式" }]}
                submitLabel="确认护理动作并安排出所回访" />
            ) : p.status === "disputed" ? (
              <DataForm key="d" compact action="refund_plans.resolve_dispute" hidden={{ id: Number(p.id) }}
                fields={[{ name: "note", label: "家属异议处理说明", required: true }]} submitLabel="处理异议" />
            ) : <span key="x" className="muted small">等待财务下一步</span>,
          ])} />
        {checkoutFollowUps.length > 0 && (
          <div className="mt8">
            <div className="muted small">提前退所自动生成的出所回访（护理主管安排）：</div>
            <DataTable cols={["房间", "计划时间", "内容", "结果登记"]}
              rows={checkoutFollowUps.map((f) => [
                <Link key="r" href={`/stays/${f.stay_id}`}>{String(f.number)} {String(f.mother_name)}</Link>,
                dt(f.scheduled_at), String(f.content),
                <DataForm key="ff" compact action="followups.done" hidden={{ id: Number(f.id) }}
                  fields={[{ name: "result", label: "回访结果", required: true }]} submitLabel="完成回访" />,
              ])} />
          </div>
        )}
      </Section>

      <Section title="异常工单中心（全中心）" tone={exceptions.length ? "tone-red" : ""}>
        <DataTable cols={["房间", "类型", "标题", "严重度", "状态", "责任角色", "处理"]} empty="暂无待处理异常"
          rows={exceptions.map((e) => [
            <Link key="r" href={`/stays/${e.stay_id}`}>{String(e.number)}</Link>,
            EX_TYPES[String(e.type)] || String(e.type),
            <span key="t">{String(e.title)}<div className="muted small">{String(e.description)}</div></span>,
            <Badge key="s" text={SEVERITY[String(e.severity)] || ""} cls={severityClass(String(e.severity))} />,
            <Badge key="st" text={EX_STATUS[String(e.status)] || ""} cls={badgeClass(String(e.status))} />,
            String(e.assigned_role),
            <DataForm key="f" compact action="exceptions.update" hidden={{ id: Number(e.id) }}
              fields={[
                { name: "action", label: "操作", type: "select", required: true, options: [
                  { value: "accept", label: "受理" }, { value: "note", label: "追加记录" },
                  { value: "resolve", label: "解决" }, { value: "close", label: "关闭" }] },
                { name: "note", label: "处理说明" },
              ]} submitLabel="提交" />,
          ])} />
      </Section>

      <div className="grid cols-2">
        <Section title="退所争议 / 护理记录质疑（同步护士长）">
          <DataTable cols={["房间", "类型", "标题", "状态", "解决情况"]} empty="暂无争议"
            rows={disputes.map((e) => [
              <Link key="r" href={`/stays/${e.stay_id}`}>{String(e.number)}</Link>,
              EX_TYPES[String(e.type)] || String(e.type),
              String(e.title),
              <Badge key="st" text={EX_STATUS[String(e.status)] || ""} cls={badgeClass(String(e.status))} />,
              <span key="res" className="small">{String(e.resolution || "处理中")}</span>,
            ])} />
        </Section>

        <Section title="月嫂请假协调">
          <DataTable cols={["房间", "请假事由", "状态", "替班安排"]} empty="暂无请假"
            rows={leaves.map((e) => [
              <Link key="r" href={`/stays/${e.stay_id}`}>{String(e.number)}</Link>,
              <span key="t">{String(e.title)}<div className="muted small">{String(e.description)}</div></span>,
              <Badge key="st" text={EX_STATUS[String(e.status)] || ""} cls={badgeClass(String(e.status))} />,
              <DataForm key="f" compact action="matron.leave" hidden={{ stayId: Number(e.stay_id) }}
                fields={[
                  { name: "fromDate", label: "开始", type: "date", required: true },
                  { name: "toDate", label: "结束", type: "date", required: true },
                  { name: "reason", label: "说明", defaultValue: "替班安排" },
                  { name: "reassignTo", label: "替班人员", type: "select", options: matrons.map((m) => ({ value: String(m.id), label: String(m.name) })) },
                ]} submitLabel="改派夜间照护" />,
            ])} />
          <div className="muted small mt8">在住房间：
            {inStays.map((s) => (
              <Link key={String(s.id)} href={`/stays/${s.id}`} className="badge blue" style={{ marginRight: 6 }}>
                {String(s.number)} {String(s.mother_name)}
              </Link>
            ))}
          </div>
        </Section>
      </div>

      <div className="grid cols-2">
        <Section title="家属反馈（回复并标记是否影响排班）">
          <DataTable cols={["房间", "评分", "内容", "回复"]} empty="暂无反馈"
            rows={feedbacks.map((f) => [
              <Link key="r" href={`/stays/${f.stay_id}`}>{String(f.number)}</Link>,
              <span key="s" className={Number(f.rating) <= 2 ? "badge red" : "badge green"}>{"★".repeat(Number(f.rating))}</span>,
              <span key="c">{String(f.content)}{Number(f.affect_scheduling) ? <span className="badge amber">影响排班</span> : null}</span>,
              f.status === "new" ? (
                <DataForm key="rf" compact action="feedbacks.respond" hidden={{ id: Number(f.id) }}
                  fields={[
                    { name: "response", label: "回复内容", required: true },
                    { name: "affectScheduling", label: "影响护理师排班", type: "checkbox" },
                  ]} submitLabel="回复" />
              ) : <span key="resp" className="small">{String(f.response)}</span>,
            ])} />
        </Section>

        <Section title="出所后回访 / 母婴随访">
          <DataTable cols={["房间", "类型", "计划时间", "内容", "结果"]} empty="暂无待执行随访"
            rows={followUps.map((f) => [
              <Link key="r" href={`/stays/${f.stay_id}`}>{String(f.number)}</Link>,
              String(f.type), dt(f.scheduled_at), String(f.content),
              <DataForm key="ff" compact action="followups.done" hidden={{ id: Number(f.id) }}
                fields={[{ name: "result", label: "随访结果", required: true }]} submitLabel="完成" />,
            ])} />
        </Section>
      </div>
    </AppShell>
  );
}
