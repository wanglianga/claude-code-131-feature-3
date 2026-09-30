import Link from "next/link";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, Badge } from "@/components/ui";
import { DataForm } from "@/components/client";
import { RefundPanel } from "@/components/refund";
import { EX_TYPES, EX_STATUS, SEVERITY, dt, badgeClass, severityClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function HeadNursePage() {
  const user = await requireUser(["head_nurse", "admin"]);
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

  // 提前退所：尾款已冻结、待护士长核对护理动作
  const refundPlans = q(
    `SELECT rp.*, r.number, s.mother_name FROM refund_plans rp
     JOIN stays s ON s.id=rp.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE rp.frozen=1 AND rp.care_confirmed=0 AND rp.status NOT IN ('refunded','rejected')
     ORDER BY rp.frozen_at`);
  const planEvents = q("SELECT * FROM refund_plan_events ORDER BY created_at DESC");

  return (
    <AppShell title="护士长工作台">
      <div className="grid cols-4">
        <div className="stat"><div className="num">{exceptions.length}</div><div className="label">待处理异常工单</div></div>
        <div className="stat"><div className="num">{disputes.filter((d) => d.status === "open").length}</div><div className="label">同步我的争议/质疑</div></div>
        <div className="stat"><div className="num">{refundPlans.length}</div><div className="label">提前退所待护理核对</div></div>
        <div className="stat"><div className="num">{feedbacks.filter((f) => f.status === "new").length}</div><div className="label">待回复家属反馈</div></div>
      </div>

      {refundPlans.map((plan) => (
        <RefundPanel key={String(plan.id)} plan={plan} user={user}
          events={planEvents.filter((ev) => Number(ev.refund_plan_id) === Number(plan.id))}
          roomNumber={String(plan.number)} compact />
      ))}

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
                { name: "op", label: "操作", type: "select", required: true, options: [
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
