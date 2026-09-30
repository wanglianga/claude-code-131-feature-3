import { redirect } from "next/navigation";
import { q, q1 } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, KV, Badge } from "@/components/ui";
import { DataForm } from "@/components/client";
import { PLAN_TYPES, VISIT_STATUS, FEE_TYPES, REFUND_PLAN_STATUS, money, dt, badgeClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function FamilyPage() {
  const user = await requireUser(["family"]);
  const link = q1(
    `SELECT fl.stay_id, fl.relation, fl.name AS link_name FROM family_links fl
     JOIN stays s ON s.id=fl.stay_id
     WHERE fl.user_id=? ORDER BY s.status='in_stay' DESC, fl.id DESC LIMIT 1`, user.id);
  if (!link) {
    return (
      <AppShell title="家属端">
        <Section title="提示"><div className="empty">您的账号尚未关联入住订单，请联系前台登记。</div></Section>
      </AppShell>
    );
  }
  const stayId = Number(link.stay_id);
  const stay = q1(
    `SELECT s.*, r.number AS room_number, r.type AS room_type, p.name AS package_name
     FROM stays s JOIN rooms r ON r.id=s.room_id JOIN packages p ON p.id=s.package_id WHERE s.id=?`, stayId)!;
  const perms = JSON.parse(String(stay.visit_permissions || "{}"));
  const showCare = perms.careSummary !== false;
  const showFees = perms.fees !== false;
  const showVisits = perms.visits !== false;

  const records = showCare
    ? q(`SELECT * FROM care_records WHERE stay_id=? AND visible_to_family=1 ORDER BY created_at DESC LIMIT 20`, stayId)
    : [];
  const todayTasks = showCare
    ? q(`SELECT t.*, u.name AS assignee FROM care_tasks t LEFT JOIN users u ON u.id=t.assignee_id
         WHERE t.stay_id=? AND t.visible_to_family=1 AND t.status='done' ORDER BY t.done_at DESC LIMIT 10`, stayId)
    : [];
  const visits = showVisits ? q("SELECT * FROM visits WHERE stay_id=? ORDER BY visit_time DESC LIMIT 10", stayId) : [];
  const fees = showFees ? q("SELECT * FROM fees WHERE stay_id=? AND status='confirmed' ORDER BY created_at", stayId) : [];
  const settlement = showFees ? q1("SELECT * FROM settlements WHERE stay_id=?", stayId) : undefined;
  const refundPlan = showFees
    ? q1("SELECT * FROM refund_plans WHERE stay_id=? AND status IN ('family_synced','disputed','reviewed') ORDER BY id DESC LIMIT 1", stayId)
    : undefined;
  const planEvents = refundPlan
    ? q("SELECT * FROM refund_plan_events WHERE plan_id=? AND action IN ('family_synced','family_acked','family_disputed','dispute_resolved','reviewed') ORDER BY created_at", Number(refundPlan.id))
    : [];
  const feedbacks = q("SELECT * FROM feedbacks WHERE stay_id=? ORDER BY created_at DESC LIMIT 10", stayId);
  const followUps = q("SELECT * FROM follow_ups WHERE stay_id=? ORDER BY scheduled_at", stayId);
  const messages = q("SELECT * FROM messages WHERE stay_id=? AND audience IN ('all','family') ORDER BY created_at DESC LIMIT 10", stayId);
  const rounds = showCare ? q("SELECT * FROM doctor_rounds WHERE stay_id=? ORDER BY round_date DESC LIMIT 5", stayId) : [];

  const feeTotal = fees.filter((f) => f.direction === "charge").reduce((s, f) => s + Number(f.amount), 0);
  const refundTotal = fees.filter((f) => f.direction === "refund").reduce((s, f) => s + Number(f.amount), 0);

  return (
    <AppShell title={`家属端 · ${stay.mother_name}（${stay.room_number}房）`}>
      <Section title="入住信息" extra={<Badge text={stay.status === "in_stay" ? "在住" : "已出所"} cls={badgeClass(String(stay.status))} />}>
        <KV items={[
          ["房间 / 套餐", `${stay.room_number}（${stay.room_type}）/ ${stay.package_name}`],
          ["入住 / 预计出所", `${stay.check_in_date} ~ ${stay.expected_checkout}${stay.actual_checkout ? `（实际 ${stay.actual_checkout}）` : ""}`],
          ["宝宝", `${stay.baby_name} · ${stay.baby_weight}kg`],
          ["黄疸观察", `${stay.jaundice_level}mg/dL ${stay.jaundice_note || ""}`],
          ["哺乳方式", String(stay.feeding_method)],
          ["我的身份", `${link.link_name}（${link.relation}）`],
        ]} />
      </Section>

      {refundPlan && (
        <Section title="提前退所退款方案（家属端同步）"
          tone={refundPlan.status === "disputed" ? "tone-red" : ""}
          extra={
            <Badge
              text={REFUND_PLAN_STATUS[String(refundPlan.status)] || String(refundPlan.status)}
              cls={badgeClass(String(refundPlan.status === "family_synced" ? "processing" : refundPlan.status))} />
          }>
          <div className="small muted">退所原因：{String(refundPlan.reason)} ｜ 拟退所日期：{String(refundPlan.checkout_date)}</div>
          <div className="mt8">
            <KV items={[
              ["已住 / 未住天数", `${refundPlan.stayed_days} 天 / ${refundPlan.remaining_days} 天（日均价 ${money(refundPlan.daily_rate)}）`],
              ["房型费用", money(refundPlan.room_charge)],
              ["餐食成本", `${money(refundPlan.meal_cost)}（${refundPlan.meal_days} 天 × ${money(refundPlan.meal_unit_cost)}）`],
              ["已执行产康", `${money(refundPlan.recovery_cost)}（${refundPlan.recovery_done_count} 次 × ${money(refundPlan.recovery_unit_cost)}）`],
              ["赠送服务", <span key="g">{money(refundPlan.gifts_delivered_value)}<div className="muted small">{String(refundPlan.gifts_note)}</div></span>],
              ["押金", `${money(refundPlan.deposit_amount)}（原路退还）`],
              ["应退合计", <b key="r" style={{ color: "#0b7" }}>{money(refundPlan.total_refund)}</b>],
              ["护理动作核对", Number(refundPlan.care_verified)
                ? <span key="y" className="badge green">护士长已核对 {dt(refundPlan.care_verified_at)}</span>
                : <span key="n" className="badge amber">核对中</span>],
              ["财务复核", refundPlan.status === "reviewed"
                ? <span key="y" className="badge green">已复核 {dt(refundPlan.reviewed_at)}，{String(refundPlan.review_note)}</span>
                : <span key="n" className="badge amber">待财务复核</span>],
            ]} />
          </div>
          <div className="muted small mt8">套餐尾款已冻结：方案确认前中心不会追加费用或退款；出所回访已同步安排。</div>
          {refundPlan.status !== "reviewed" && (
            <div className="mt8 row">
              {refundPlan.family_status !== "acked" && (
                <DataForm compact action="refund_plans.ack" hidden={{ id: Number(refundPlan.id) }}
                  fields={[{ name: "note", label: "知悉备注（可选）", placeholder: "已知悉退款明细，无异议" }]}
                  submitLabel="已知悉，等待退款" />
              )}
              {refundPlan.family_status === "acked" && <span className="badge green">您已知悉该方案</span>}
              {refundPlan.family_status === "disputed" && <span className="badge red">您的异议处理中：{String(refundPlan.family_note)}</span>}
              <DataForm compact action="refund_plans.dispute" hidden={{ id: Number(refundPlan.id) }}
                fields={[{ name: "note", label: "如有异议请说明（必填）", required: true, placeholder: "如：对餐食天数/产康次数有疑问" }]}
                submitLabel="提出异议" />
            </div>
          )}
          {refundPlan.status === "reviewed" && (
            <div className="mt8 badge green" style={{ padding: 8 }}>
              退款已财务复核，{Number(refundPlan.total_refund) >= 0 ? `${money(refundPlan.total_refund)} 将按支付渠道退回` : `应补 ${money(-Number(refundPlan.total_refund))}`}；出所手续已办结，请留意出所回访电话。
            </div>
          )}
          <ul className="timeline mt8">
            {planEvents.map((ev) => (
              <li key={String(ev.id)}>
                <span className="t-time">{dt(ev.created_at)}</span>
                <b>{String(ev.user_name)}</b> {String(ev.note)}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {showCare && (
        <div className="grid cols-2">
          <Section title="护理摘要（经授权）">
            <DataTable cols={["时间", "内容", "记录人", "操作"]} empty="暂无护理摘要"
              rows={records.map((r) => [
                <span key="t" className="small">{dt(r.created_at)}</span>,
                <span key="c">{String(r.content)}</span>,
                String(r.created_by_name),
                Number(r.disputed)
                  ? <span key="d" className="badge red">已质疑，核查中</span>
                  : (
                    <DataForm key="df" compact action="records.dispute" hidden={{ id: Number(r.id) }}
                      fields={[{ name: "reason", label: "质疑原因", placeholder: "如与实际不符，请说明" }]}
                      submitLabel="质疑" />
                  ),
              ])} />
            <div className="muted small mt8">已完成的护理项目：</div>
            <DataTable cols={["时间", "项目", "执行人"]} empty="暂无"
              rows={todayTasks.map((t) => [
                <span key="t" className="small">{dt(t.done_at)}</span>,
                <span key="n">{PLAN_TYPES[String(t.type)] || String(t.type)} · {String(t.title)}</span>,
                String(t.assignee || "-"),
              ])} />
          </Section>

          <Section title="医生巡诊与随访">
            <DataTable cols={["日期", "查体发现", "医生建议"]} empty="暂无巡诊记录"
              rows={rounds.map((r) => [String(r.round_date), String(r.findings), String(r.advice)])} />
            <div className="muted small mt8">回访 / 随访安排：</div>
            <DataTable cols={["类型", "时间", "状态", "结果"]} empty="暂无随访安排"
              rows={followUps.map((f) => [
                String(f.type), dt(f.scheduled_at),
                <Badge key="s" text={f.status === "done" ? "已完成" : "待执行"} cls={badgeClass(String(f.status))} />,
                String(f.result || "-"),
              ])} />
          </Section>
        </div>
      )}

      <div className="grid cols-2">
        {showVisits && (
          <Section title="探访预约">
            <DataForm compact action="visits.create" hidden={{ stayId }}
              fields={[
                { name: "visitorName", label: "探访人姓名", required: true },
                { name: "relation", label: "与产妇关系", placeholder: "如：丈夫 / 婆婆" },
                { name: "visitTime", label: "探访时间", type: "datetime-local", required: true },
                { name: "hours", label: "时长(小时)", type: "number", defaultValue: 2 },
                { name: "isTemp", label: "临时增加探访", type: "checkbox" },
              ]} submitLabel="提交预约" />
            <div className="mt8">
              <DataTable cols={["探访人", "时间", "状态", "消毒"]} empty="暂无预约"
                rows={visits.map((v) => [
                  <span key="v">{String(v.visitor_name)}{Number(v.is_temp) ? <span className="badge amber">临时</span> : null}</span>,
                  <span key="t" className="small">{dt(v.visit_time)}</span>,
                  <Badge key="s" text={VISIT_STATUS[String(v.status)] || ""} cls={badgeClass(String(v.status))} />,
                  Number(v.disinfected) ? <span key="d" className="badge green">已消毒</span> : <span key="nd" className="badge gray">待入所登记</span>,
                ])} />
            </div>
          </Section>
        )}

        {showFees && (
          <Section title="费用明细">
            <DataTable cols={["时间", "项目", "方向", "金额"]} empty="暂无费用"
              rows={fees.map((f) => [
                <span key="t" className="small">{dt(f.created_at)}</span>,
                <span key="d">{FEE_TYPES[String(f.type)] || String(f.type)} · {String(f.description)}</span>,
                f.direction === "refund" ? <span key="r" className="badge blue">退款</span> : <span key="c" className="badge gray">应收</span>,
                <b key="m">{money(f.amount)}</b>,
              ])} />
            <div className="mt8">
              <KV items={[
                ["应收合计", money(feeTotal)],
                ["退款合计", money(refundTotal)],
                ["应付净额", <b key="n">{money(feeTotal - refundTotal)}</b>],
                ...(settlement ? [["结算状态", <Badge key="s" text={settlement.status === "confirmed" ? "已结算" : "结算中"} cls={badgeClass(String(settlement.status))} />] as [string, React.ReactNode]] : []),
              ]} />
            </div>
          </Section>
        )}
      </div>

      <div className="grid cols-2">
        <Section title="意见反馈（影响护理师排班与中心口碑）">
          <DataForm compact action="feedbacks.create" hidden={{ stayId }}
            fields={[
              { name: "rating", label: "评分", type: "select", required: true, options: [5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: "★".repeat(n) })) },
              { name: "content", label: "反馈内容", type: "textarea", required: true },
            ]} submitLabel="提交反馈" />
          <div className="mt8">
            <DataTable cols={["时间", "评分", "内容", "中心回复"]} empty="暂无反馈"
              rows={feedbacks.map((f) => [
                <span key="t" className="small">{dt(f.created_at)}</span>,
                <span key="r" className={Number(f.rating) <= 2 ? "badge red" : "badge green"}>{"★".repeat(Number(f.rating))}</span>,
                String(f.content),
                <span key="resp" className="small">{String(f.response || "待回复")}</span>,
              ])} />
          </div>
        </Section>

        <Section title="与中心沟通">
          <DataForm compact action="messages.create" hidden={{ stayId }}
            fields={[{ name: "content", label: "留言内容", type: "textarea", required: true, placeholder: "如：想咨询明天增加一次探访" }]}
            submitLabel="发送留言" />
          <ul className="timeline mt8">
            {messages.map((m) => (
              <li key={String(m.id)}>
                <span className="t-time">{dt(m.created_at)}</span>
                <b>{String(m.from_name)}</b>：{String(m.content)}
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </AppShell>
  );
}
