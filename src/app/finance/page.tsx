import Link from "next/link";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, Badge } from "@/components/ui";
import { DataForm, ActionButton } from "@/components/client";
import { RefundPanel } from "@/components/refund";
import { FEE_TYPES, REFUND_STATUS, money, dt, badgeClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function FinancePage() {
  const user = await requireUser(["finance", "admin"]);
  const stays = q(
    `SELECT s.id, s.mother_name, s.status, s.actual_checkout, r.number, p.name AS package_name,
       (SELECT COALESCE(SUM(CASE WHEN f.direction='charge' THEN f.amount ELSE -f.amount END),0)
          FROM fees f WHERE f.stay_id=s.id AND f.status='confirmed') AS net
     FROM stays s JOIN rooms r ON r.id=s.room_id JOIN packages p ON p.id=s.package_id
     ORDER BY s.status='in_stay' DESC, r.number`);
  const recentFees = q(
    `SELECT f.*, r.number, s.mother_name FROM fees f
     JOIN stays s ON s.id=f.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY f.created_at DESC LIMIT 20`);
  const settlements = q(
    `SELECT st.*, r.number, s.mother_name FROM settlements st
     JOIN stays s ON s.id=st.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY st.status='draft' DESC, st.created_at DESC`);
  const inStays = stays.filter((s) => s.status === "in_stay");

  // 提前退所退款方案（未完成的在前）
  const refundPlans = q(
    `SELECT rp.*, r.number, s.mother_name FROM refund_plans rp
     JOIN stays s ON s.id=rp.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY rp.status='refunded' ASC, rp.created_at DESC`);
  const planEvents = q(
    `SELECT * FROM refund_plan_events ORDER BY created_at DESC`);
  const activePlans = refundPlans.filter((p) => p.status !== "refunded");
  const frozenCount = refundPlans.filter((p) => Number(p.frozen) === 1 && p.status !== "refunded").length;
  const reviewCount = refundPlans.filter((p) => Number(p.family_synced) === 1 && p.status !== "refunded").length;

  return (
    <AppShell title="财务工作台">
      <div className="grid cols-4">
        <div className="stat"><div className="num">{inStays.length}</div><div className="label">在住订单</div></div>
        <div className="stat"><div className="num">{activePlans.length}</div><div className="label">提前退所进行中</div></div>
        <div className="stat"><div className="num">{frozenCount}</div><div className="label">套餐尾款冻结中</div></div>
        <div className="stat"><div className="num">{reviewCount}</div><div className="label">待财务复核退款</div></div>
      </div>

      {activePlans.map((plan) => (
        <div key={String(plan.id)} className="mb16">
          <RefundPanel plan={plan} user={user}
            events={planEvents.filter((ev) => Number(ev.refund_plan_id) === Number(plan.id))}
            roomNumber={String(plan.number)} compact />
        </div>
      ))}

      <Section title="登记费用 / 退款">
        <DataForm action="fees.create"
          fields={[
            { name: "stayId", label: "订单（房间）", type: "select", required: true, options: stays.map((s) => ({ value: String(s.id), label: `${s.number} ${s.mother_name}（${s.status === "in_stay" ? "在住" : "已出所"}）` })) },
            { name: "type", label: "费用类型", type: "select", required: true, options: Object.entries(FEE_TYPES).map(([v, l]) => ({ value: v, label: l })) },
            { name: "direction", label: "方向", type: "select", required: true, options: [{ value: "charge", label: "应收" }, { value: "refund", label: "退款" }] },
            { name: "amount", label: "金额(元)", type: "number", required: true },
            { name: "description", label: "说明", required: true, placeholder: "如：产康加项2次" },
          ]} submitLabel="登记" />
        <div className="muted small mt8">提前退所由前台/财务在房间视图提交申请，本页生成退款方案并冻结套餐尾款；尾款冻结期间结算单不可确认。</div>
      </Section>

      <Section title="结算单（出所订单）">
        <DataTable cols={["房间", "产妇", "应收", "退款", "实收", "余额", "尾款冻结", "状态", "操作"]} empty="暂无结算单"
          rows={settlements.map((s) => [
            <Link key="r" href={`/stays/${s.stay_id}`}>{String(s.number)}</Link>,
            String(s.mother_name),
            money(s.total_charge), money(s.total_refund), money(s.paid),
            Number(s.balance) < 0
              ? <b key="b" className="badge blue">应退 {money(-Number(s.balance))}</b>
              : <b key="b">{money(s.balance)}</b>,
            Number(s.frozen_balance) > 0
              ? <span key="fz" className="badge amber">冻结 {money(s.frozen_balance)}</span>
              : <span key="nf" className="muted small">-</span>,
            <Badge key="st" text={s.status === "confirmed" ? "已确认" : "待确认"} cls={badgeClass(String(s.status))} />,
            s.status !== "confirmed"
              ? <ActionButton key="c" action="settlements.confirm" payload={{ stayId: Number(s.stay_id) }} label="确认结算" kind="primary" confirm="确认该订单结算无误？" />
              : <span key="d" className="muted small">{dt(s.confirmed_at)}</span>,
          ])} />
      </Section>

      {refundPlans.filter((p) => p.status === "refunded").length > 0 && (
        <Section title="已完成提前退所退款">
          <DataTable cols={["房间", "产妇", "申请退所", "已住/剩余", "套餐尾款", "应退", "状态", "复核时间"]} empty="暂无"
            rows={refundPlans.filter((p) => p.status === "refunded").map((p) => [
              <Link key="r" href={`/stays/${p.stay_id}`}>{String(p.number)}</Link>,
              String(p.mother_name), dt(p.planned_checkout),
              `${p.lived_days}/${p.remain_days}天`,
              money(p.tail_frozen), <b key="m">{money(p.refund_amount)}</b>,
              <Badge key="s" text={REFUND_STATUS[String(p.status)] || ""} cls={badgeClass(String(p.status))} />,
              <span key="t" className="small">{dt(p.reviewed_at)}</span>,
            ])} />
        </Section>
      )}

      <Section title="费用流水（全部房间）">
        <DataTable cols={["时间", "房间", "产妇", "类型", "说明", "方向", "金额", "状态"]} empty="暂无费用"
          rows={recentFees.map((f) => [
            <span key="t" className="small">{dt(f.created_at)}</span>,
            <Link key="r" href={`/stays/${f.stay_id}`}>{String(f.number)}</Link>,
            String(f.mother_name),
            FEE_TYPES[String(f.type)] || String(f.type),
            String(f.description),
            f.direction === "refund" ? <span key="d" className="badge blue">退款</span> : <span key="c" className="badge gray">应收</span>,
            <b key="m">{money(f.amount)}</b>,
            <Badge key="s" text={f.status === "void" ? "已作废" : "已确认"} cls={badgeClass(String(f.status))} />,
          ])} />
      </Section>
    </AppShell>
  );
}
